// Harness Mix executable bridge, built from this source by build-native.cjs.
// Rust port of the original shim.cs: identical routing and stdio contract.
//
// - `... app-server ...`  -> node scripts/native-host.cjs (Harness Mix kernel)
// - anything else         -> stock codex.exe passthrough
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

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

fn setting(env_name: &str, file: &Path) -> io::Result<String> {
    match env::var(env_name) {
        Ok(value) if !value.is_empty() => Ok(value),
        _ => read_trimmed(file),
    }
}

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
    let server = args.iter().any(|arg| arg == "app-server");

    let build_dir = root.join("output").join("native-build");
    let stock = setting(
        "CODEXHOST_STOCK_CODEX_PATH",
        &build_dir.join("stock-path.txt"),
    )?;
    let node = setting("HARNESS_MIX_NODE_PATH", &build_dir.join("node-path.txt"))?;
    log_spawn(exe_dir, if server { "server" } else { "passthrough" }, &args);

    let mut command = if server {
        let mut command = Command::new(&node);
        command.arg(root.join("scripts").join("native-host.cjs"));
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
        .env("CODEXHOST_STOCK_CODEX_PATH", &stock);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

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
