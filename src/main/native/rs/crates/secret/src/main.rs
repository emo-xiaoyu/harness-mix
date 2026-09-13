//! Platform secret store for Harness Mix: per-user DPAPI vault with a minimal
//! line-based file format. Zero external crates; raw crypt32/kernel32 FFI.
//!
//! Vault: <data>/secrets.dat
//!   # harness-mix-secrets v1
//!   <name> <base64(dpapi blob)>
//!
//! CLI: set <name> (value on stdin) | get <name> | delete <name> | list
//! Exit codes: 0 ok, 1 error, 2 not found.
#![cfg(windows)]

use std::env;
use std::ffi::c_void;
use std::fs;
use std::io::{self, Read, Write};
use std::path::PathBuf;

#[repr(C)]
struct DataBlob {
    cb_data: u32,
    pb_data: *mut u8,
}

#[link(name = "crypt32")]
extern "system" {
    fn CryptProtectData(
        data_in: *const DataBlob,
        description: *const u16,
        entropy: *const DataBlob,
        reserved: *mut c_void,
        prompt: *mut c_void,
        flags: u32,
        data_out: *mut DataBlob,
    ) -> i32;
    fn CryptUnprotectData(
        data_in: *const DataBlob,
        description: *mut *mut u16,
        entropy: *const DataBlob,
        reserved: *mut c_void,
        prompt: *mut c_void,
        flags: u32,
        data_out: *mut DataBlob,
    ) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn LocalFree(memory: *mut c_void) -> *mut c_void;
}

const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;
const MARKER: &str = "# harness-mix-secrets v1";

fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    transform(plain, true)
}

fn unprotect(blob: &[u8]) -> Result<Vec<u8>, String> {
    transform(blob, false)
}

// DPAPI round-trip, current user scope. The description pointer stays null so
// no extra allocation needs freeing on the unprotect path.
fn transform(input: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    let data_in = DataBlob { cb_data: input.len() as u32, pb_data: input.as_ptr() as *mut u8 };
    let mut data_out = DataBlob { cb_data: 0, pb_data: std::ptr::null_mut() };
    let ok: i32 = unsafe {
        if encrypt {
            CryptProtectData(&data_in, std::ptr::null(), std::ptr::null(), std::ptr::null_mut(), std::ptr::null_mut(), CRYPTPROTECT_UI_FORBIDDEN, &mut data_out)
        } else {
            let mut description: *mut u16 = std::ptr::null_mut();
            CryptUnprotectData(&data_in, &mut description, std::ptr::null(), std::ptr::null_mut(), std::ptr::null_mut(), CRYPTPROTECT_UI_FORBIDDEN, &mut data_out)
        }
    };
    if ok == 0 {
        return Err("DPAPI 调用失败（数据可能由其他用户加密）".to_string());
    }
    let bytes = unsafe { std::slice::from_raw_parts(data_out.pb_data, data_out.cb_data as usize).to_vec() };
    unsafe { LocalFree(data_out.pb_data as *mut c_void) };
    Ok(bytes)
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let bytes = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let packed = ((bytes[0] as u32) << 16) | ((bytes[1] as u32) << 8) | bytes[2] as u32;
        out.push(B64[(packed >> 18) as usize & 63] as char);
        out.push(B64[(packed >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(packed >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[packed as usize & 63] as char } else { '=' });
    }
    out
}

fn base64_value(byte: u8) -> Result<u32, String> {
    match byte {
        b'A'..=b'Z' => Ok((byte - b'A') as u32),
        b'a'..=b'z' => Ok((byte - b'a' + 26) as u32),
        b'0'..=b'9' => Ok((byte - b'0' + 52) as u32),
        b'+' => Ok(62),
        b'/' => Ok(63),
        _ => Err(format!("无效 base64 字节 0x{byte:02X}")),
    }
}

fn base64_decode(text: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &byte in text.as_bytes() {
        if byte == b'=' {
            continue;
        }
        acc = (acc << 6) | base64_value(byte)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

fn data_dir() -> Result<PathBuf, String> {
    if let Ok(dir) = env::var("CODEXHOST_DATA_DIR") {
        if !dir.trim().is_empty() {
            return Ok(PathBuf::from(dir));
        }
    }
    match env::var("APPDATA") {
        Ok(appdata) if !appdata.trim().is_empty() => Ok(PathBuf::from(appdata).join("harness-mix").join("codexhost")),
        _ => Err("无法确定数据目录（缺少 APPDATA / CODEXHOST_DATA_DIR）".to_string()),
    }
}

fn vault_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("secrets.dat"))
}

fn load_entries() -> Result<Vec<(String, Vec<u8>)>, String> {
    let path = vault_path()?;
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(_) => return Ok(Vec::new()),
    };
    let mut entries = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.splitn(2, ' ');
        let name = parts.next().unwrap_or_default().trim().to_string();
        let encoded = parts.next().unwrap_or_default().trim();
        if name.is_empty() || encoded.is_empty() {
            return Err(format!("损坏的保险箱条目：{line}"));
        }
        entries.push((name, base64_decode(encoded)?));
    }
    Ok(entries)
}

fn save_entries(entries: &[(String, Vec<u8>)]) -> Result<(), String> {
    let path = vault_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut text = String::from(MARKER);
    text.push('\n');
    for (name, blob) in entries {
        text.push_str(name);
        text.push(' ');
        text.push_str(&base64_encode(blob));
        text.push('\n');
    }
    let temp = path.with_extension("dat.tmp");
    fs::write(&temp, text).map_err(|error| error.to_string())?;
    fs::rename(&temp, &path).map_err(|error| error.to_string())?;
    Ok(())
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'_' || byte == b'-')
}

fn run() -> Result<i32, String> {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("set") => {
            let name = args.get(1).ok_or_else(|| "用法：harness-mix-secret set <name>（值从 stdin 读入）".to_string())?;
            if !valid_name(name) {
                return Err("名称只允许 [A-Za-z0-9._-]{1,64}".to_string());
            }
            let mut value = Vec::new();
            io::stdin().read_to_end(&mut value).map_err(|error| error.to_string())?;
            if value.is_empty() {
                return Err("拒绝写入空值".to_string());
            }
            let mut entries = load_entries()?;
            let blob = protect(&value)?;
            match entries.iter_mut().find(|(existing, _)| existing == name) {
                Some(entry) => entry.1 = blob,
                None => entries.push((name.to_string(), blob)),
            }
            save_entries(&entries)?;
            Ok(0)
        }
        Some("get") => {
            let name = args.get(1).ok_or_else(|| "用法：harness-mix-secret get <name>".to_string())?;
            let entries = load_entries()?;
            match entries.iter().find(|(existing, _)| existing == name) {
                Some((_, blob)) => {
                    let value = unprotect(blob)?;
                    io::stdout().write_all(&value).map_err(|error| error.to_string())?;
                    Ok(0)
                }
                None => {
                    eprintln!("未找到：{name}");
                    Ok(2)
                }
            }
        }
        Some("delete") => {
            let name = args.get(1).ok_or_else(|| "用法：harness-mix-secret delete <name>".to_string())?;
            let mut entries = load_entries()?;
            let before = entries.len();
            entries.retain(|(existing, _)| existing != name);
            if entries.len() == before {
                eprintln!("未找到：{name}");
                return Ok(2);
            }
            save_entries(&entries)?;
            Ok(0)
        }
        Some("list") => {
            let entries = load_entries()?;
            let mut out = String::new();
            for (name, _) in entries {
                out.push_str(&name);
                out.push('\n');
            }
            io::stdout().write_all(out.as_bytes()).map_err(|error| error.to_string())?;
            Ok(0)
        }
        _ => Err("用法：harness-mix-secret <set|get|delete|list> [name]".to_string()),
    }
}

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(message) => {
            eprintln!("Harness Mix secret: {message}");
            std::process::exit(1);
        }
    }
}
