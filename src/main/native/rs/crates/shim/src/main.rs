// Harness Mix executable bridge, built from this source by build-native.cjs.
// Rust port of the original shim.cs: identical routing and stdio contract.
//
// - a plain `app-server` invocation -> node scripts/native-host.cjs
// - management subcommands and every other invocation -> stock Codex passthrough
use std::env;
use std::fs;
use std::io::{self, Write};
#[cfg(not(unix))]
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
#[cfg(not(unix))]
use std::sync::{Arc, Mutex};
#[cfg(not(unix))]
use std::thread;

mod job;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn read_trimmed(path: &Path) -> io::Result<String> {
    Ok(fs::read_to_string(path)?.trim().to_string())
}

fn json_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

// Invocation journal next to the exe: one JSON line on spawn, one on exit.
// The desktop spawns this shim for every CLI call, so this is the ground
// truth for which invocation fails and with what stderr.
fn log_line(exe_dir: &Path, line: &str) {
    let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(exe_dir.join("shim-invocations.log"))
    else {
        return;
    };
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let _ = writeln!(file, "{{\"ts\":{ts},{line}}}");
}

fn log_spawn(exe_dir: &Path, mode: &str, args: &[String]) {
    let args = args
        .iter()
        .map(|a| format!("\"{}\"", json_escape(a)))
        .collect::<Vec<_>>()
        .join(",");
    log_line(
        exe_dir,
        &format!(
            "\"pid\":{},\"mode\":\"{}\",\"args\":[{}]",
            std::process::id(),
            mode,
            args
        ),
    );
}

#[cfg(not(unix))]
fn log_exit(exe_dir: &Path, code: i32, stderr_tail: &[u8]) {
    let tail = json_escape(&String::from_utf8_lossy(stderr_tail));
    log_line(
        exe_dir,
        &format!(
            "\"pid\":{},\"exit\":{},\"stderr_tail\":\"{}\"",
            std::process::id(),
            code,
            tail
        ),
    );
}

// Keep the invocation journal bounded: one live file plus two rotations.
const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

fn rotate_log(dir: &Path) {
    let base = dir.join("shim-invocations.log");
    let Ok(metadata) = fs::metadata(&base) else { return };
    if metadata.len() < LOG_MAX_BYTES { return; }
    let _ = fs::remove_file(dir.join("shim-invocations.log.2"));
    let _ = fs::rename(dir.join("shim-invocations.log.1"), dir.join("shim-invocations.log.2"));
    let _ = fs::rename(&base, dir.join("shim-invocations.log.1"));
}

fn setting(env_name: &str, file: &Path) -> io::Result<String> {
    match env::var(env_name) {
        Ok(value) if !value.is_empty() => Ok(value),
        _ => read_trimmed(file),
    }
}

// Locate the real Codex subcommand without mistaking a prompt or config value
// for one. Unknown global options deliberately fall back to the stock CLI, so
// native Codex remains usable when a newer CLI adds syntax unknown to the Shim.
fn app_server_subcommand_index(args: &[String]) -> Option<usize> {
    const VALUE_OPTIONS: &[&str] = &[
        "-c",
        "--config",
        "--enable",
        "--disable",
        "--profile",
    ];
    const FLAG_OPTIONS: &[&str] = &["--search", "--no-alt-screen", "--oss"];
    let mut index = 0;
    while let Some(arg) = args.get(index).map(String::as_str) {
        if arg == "app-server" {
            return Some(index);
        }
        if arg == "--" {
            return None;
        }
        if VALUE_OPTIONS.contains(&arg) {
            args.get(index + 1)?;
            index += 2;
            continue;
        }
        if VALUE_OPTIONS
            .iter()
            .any(|option| arg.strip_prefix(option).is_some_and(|rest| rest.starts_with('=')))
            || FLAG_OPTIONS.contains(&arg)
        {
            index += 1;
            continue;
        }
        return None;
    }
    None
}

// Only the app-server form used as the Desktop protocol endpoint belongs to
// Harness Mix. `proxy`, `daemon`, and future management forms stay entirely
// with the official CLI. Unknown app-server options also pass through.
fn should_start_host_runtime(args: &[String]) -> bool {
    const VALUE_OPTIONS: &[&str] = &[
        "-c",
        "--config",
        "--enable",
        "--disable",
        "--listen",
        "--ws-auth",
        "--ws-token-file",
        "--ws-token-sha256",
        "--ws-shared-secret-file",
        "--ws-issuer",
        "--ws-audience",
        "--ws-max-clock-skew-seconds",
    ];
    const FLAG_OPTIONS: &[&str] = &[
        "--strict-config",
        "--stdio",
        "--analytics-default-enabled",
    ];
    let Some(mut index) = app_server_subcommand_index(args).map(|index| index + 1) else {
        return false;
    };
    while let Some(arg) = args.get(index).map(String::as_str) {
        if VALUE_OPTIONS.contains(&arg) {
            if args.get(index + 1).is_none() {
                return false;
            }
            index += 2;
            continue;
        }
        if VALUE_OPTIONS
            .iter()
            .any(|option| arg.strip_prefix(option).is_some_and(|rest| rest.starts_with('=')))
            || FLAG_OPTIONS.contains(&arg)
        {
            index += 1;
            continue;
        }
        return false;
    }
    true
}

#[cfg(not(unix))]
fn pump<R: Read + Send + 'static, W: Write + Send + 'static>(
    mut source: R,
    mut destination: W,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let _ = io::copy(&mut source, &mut destination);
        let _ = destination.flush();
    })
}

fn run() -> io::Result<i32> {
    let exe = env::current_exe()?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Shim has no base directory"))?;
    // Path.GetFullPath equivalent: normalize without resolving symlinks or adding \\?\.
    let root = std::path::absolute(exe_dir.join("../.."))?;
    let args: Vec<String> = env::args().skip(1).collect();
    let server = should_start_host_runtime(&args);

    rotate_log(exe_dir);
    // Kill-on-close job: the node host, every harness CLI it spawns and any
    // shell children all die with this shim, including on force-kill.
    #[cfg(windows)]
    if let Err(error) = job::assign_kill_on_close() {
        eprintln!("Harness Mix Shim: process supervision unavailable: {error}");
    }

    let build_dir = root.join("output").join("native-build");
    let stock = setting(
        "HARNESSMIX_STOCK_CODEX_PATH",
        &build_dir.join("stock-path.txt"),
    )?;
    let node = setting("HARNESS_MIX_NODE_PATH", &build_dir.join("node-path.txt"))?;
    log_spawn(exe_dir, if server { "server" } else { "passthrough" }, &args);

    let mut command = if server {
        // Tests point this at a fixture host; production uses the in-repo entry.
        let host_script = env::var("HARNESS_MIX_HOST_SCRIPT")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| root.join("scripts").join("native-host.cjs"));
        let mut command = Command::new(&node);
        command.arg("--max-old-space-size=8192");
        command.arg(host_script);
        command
    } else {
        Command::new(&stock)
    };
    command
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_remove("CODEX_CLI_PATH")
        .env("HARNESSMIX_STOCK_CODEX_PATH", &stock);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    // Unix exec keeps the Desktop-owned PID and stdio: signals and EOF reach
    // the native host directly, without an extra unsupervised pump process.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
        return Err(command.exec());
    }

    #[cfg(not(unix))]
    supervise(command, exe_dir)
}

#[cfg(not(unix))]
fn supervise(mut command: Command, exe_dir: &Path) -> io::Result<i32> {
    let mut child = command.spawn()?;
    let child_stdin = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "child stdin unavailable"))?;
    let child_stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "child stdout unavailable"))?;
    let child_stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "child stderr unavailable"))?;

    // Stdin EOF must close the child's stdin, mirroring the C# pump's finally.
    let input = thread::spawn(move || {
        let stdin = io::stdin();
        let mut locked = stdin.lock();
        let mut writer = child_stdin;
        let _ = io::copy(&mut locked, &mut writer);
        let _ = writer.flush();
        drop(writer);
    });
    let output = pump(child_stdout, io::stdout());
    // Tee stderr: forward live and keep the tail for the invocation journal.
    let tail = Arc::new(Mutex::new(Vec::<u8>::new()));
    let tail_writer = Arc::clone(&tail);
    let error = thread::spawn(move || {
        let mut reader = child_stderr;
        let mut stderr = io::stderr();
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let chunk = &buffer[..count];
                    let _ = stderr.write_all(chunk);
                    let _ = stderr.flush();
                    if let Ok(mut tail) = tail_writer.lock() {
                        tail.extend_from_slice(chunk);
                        if tail.len() > 4096 {
                            let excess = tail.len() - 4096;
                            tail.drain(..excess);
                        }
                    }
                }
            }
        }
    });

    let status = child.wait()?;
    let _ = output.join();
    let _ = error.join();
    let code = status.code().unwrap_or(1);
    let tail = tail.lock().map(|t| t.clone()).unwrap_or_default();
    log_exit(&exe_dir, code, &tail);
    drop(input); // stdin may outlive the child; do not block exit on it.
    Ok(code)
}

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("Harness Mix Shim: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{app_server_subcommand_index, should_start_host_runtime};

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn finds_only_the_real_app_server_subcommand() {
        assert_eq!(app_server_subcommand_index(&args(&["app-server"])), Some(0));
        assert_eq!(
            app_server_subcommand_index(&args(&[
                "-c",
                "features.code_mode_host=true",
                "app-server",
                "--stdio",
            ])),
            Some(2)
        );
        assert_eq!(
            app_server_subcommand_index(&args(&["exec", "say app-server"])),
            None
        );
        assert_eq!(
            app_server_subcommand_index(&args(&["-c", "app-server", "exec"])),
            None
        );
        assert_eq!(app_server_subcommand_index(&args(&["--", "app-server"])), None);
    }

    #[test]
    fn routes_only_plain_desktop_app_server_to_the_host() {
        assert!(should_start_host_runtime(&args(&["app-server", "--stdio"])));
        assert!(should_start_host_runtime(&args(&[
            "-c",
            "features.code_mode_host=true",
            "app-server",
            "--listen",
            "stdio://",
            "--analytics-default-enabled",
        ])));
        assert!(should_start_host_runtime(&args(&[
            "app-server",
            "--listen=ws://127.0.0.1:0",
            "--ws-auth",
            "token",
        ])));
        assert!(!should_start_host_runtime(&args(&["app-server", "proxy"])));
        assert!(!should_start_host_runtime(&args(&["app-server", "daemon"])));
        assert!(!should_start_host_runtime(&args(&[
            "app-server",
            "--future-option",
        ])));
        assert!(!should_start_host_runtime(&args(&["exec", "app-server"])));
    }
}
