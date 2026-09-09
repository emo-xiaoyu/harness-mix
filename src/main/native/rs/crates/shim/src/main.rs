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
use std::thread;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn read_trimmed(path: &Path) -> io::Result<String> {
    Ok(fs::read_to_string(path)?.trim().to_string())
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
    let error = pump(child_stderr, io::stderr());

    let status = child.wait()?;
    let _ = output.join();
    let _ = error.join();
    drop(input); // stdin may outlive the child; do not block exit on it.
    Ok(status.code().unwrap_or(1))
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
