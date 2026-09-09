// Windows activation boundary. Rust port of appx.cs: identical COM contract.
// See Microsoft IApplicationActivationManager and IPackageDebugSettings.
// The temporary debugging environment is removed before exit on every path.
//
// Dependency-free on purpose: only ole32/kernel32 imports from Rust's bundled
// self-contained libraries, so any stock Rust toolchain can build this crate.
#![cfg(windows)]
#![allow(non_snake_case)]

use std::env;
use std::ffi::c_void;
use std::process::ExitCode;

type Hresult = i32;
type Handle = *mut c_void;
type WidePtr = *const u16;

const S_OK_MIN: Hresult = 0;
const COINIT_APARTMENTTHREADED: u32 = 0x2;
const CLSCTX_ALL: u32 = 0x17;
const THREAD_SUSPEND_RESUME: u32 = 0x0002;
const THREAD_QUERY_INFORMATION: u32 = 0x0800;
const ACTIVATEOPTIONS_VALUE: u32 = 2; // same ACTIVATEOPTIONS value as the C# build

#[repr(C)]
struct Guid {
    data1: u32,
    data2: u16,
    data3: u16,
    data4: [u8; 8],
}

// B1AEC16F-2383-4852-B0E9-8F0B1DC66B4D
const CLSID_PACKAGE_DEBUG_SETTINGS: Guid = Guid {
    data1: 0xB1AEC16F,
    data2: 0x2383,
    data3: 0x4852,
    data4: [0xB0, 0xE9, 0x8F, 0x0B, 0x1D, 0xC6, 0x6B, 0x4D],
};
// 45BA127D-10A8-46EA-8AB7-56EA9078943C
const CLSID_APPLICATION_ACTIVATION_MANAGER: Guid = Guid {
    data1: 0x45BA127D,
    data2: 0x10A8,
    data3: 0x46EA,
    data4: [0x8A, 0xB7, 0x56, 0xEA, 0x90, 0x78, 0x94, 0x3C],
};
// F27C3930-8029-4AD1-94E3-3DBA417810C1
const IID_PACKAGE_DEBUG_SETTINGS: Guid = Guid {
    data1: 0xF27C3930,
    data2: 0x8029,
    data3: 0x4AD1,
    data4: [0x94, 0xE3, 0x3D, 0xBA, 0x41, 0x78, 0x10, 0xC1],
};
// 2E941141-7F97-4756-BA1D-9DECDE894A3D
const IID_APPLICATION_ACTIVATION_MANAGER: Guid = Guid {
    data1: 0x2E941141,
    data2: 0x7F97,
    data3: 0x4756,
    data4: [0xBA, 0x1D, 0x9D, 0xEC, 0xDE, 0x89, 0x4A, 0x3D],
};

type QueryInterface = unsafe extern "system" fn(*mut c_void, *const Guid, *mut *mut c_void) -> Hresult;
type AddRef = unsafe extern "system" fn(*mut c_void) -> u32;
type Release = unsafe extern "system" fn(*mut c_void) -> u32;
type EnableDebugging =
    unsafe extern "system" fn(*mut c_void, WidePtr, WidePtr, WidePtr) -> Hresult;
type DisableDebugging = unsafe extern "system" fn(*mut c_void, WidePtr) -> Hresult;
type ActivateApplication =
    unsafe extern "system" fn(*mut c_void, WidePtr, WidePtr, u32, *mut u32) -> Hresult;

#[repr(C)]
struct PackageDebugSettingsVtbl {
    query_interface: QueryInterface,
    add_ref: AddRef,
    release: Release,
    enable_debugging: EnableDebugging,
    disable_debugging: DisableDebugging,
}

#[repr(C)]
struct ApplicationActivationManagerVtbl {
    query_interface: QueryInterface,
    add_ref: AddRef,
    release: Release,
    activate_application: ActivateApplication,
}

#[repr(C)]
struct ComObject {
    vtbl: *const c_void,
}

struct DebugSettings(*mut c_void);
impl DebugSettings {
    fn vtbl(&self) -> &PackageDebugSettingsVtbl {
        unsafe { &*((*(self.0 as *const ComObject)).vtbl as *const PackageDebugSettingsVtbl) }
    }
    fn disable(&self, package: WidePtr) {
        let _ = unsafe { (self.vtbl().disable_debugging)(self.0, package) };
    }
}
impl Drop for DebugSettings {
    fn drop(&mut self) {
        unsafe { (self.vtbl().release)(self.0) };
    }
}

struct ActivationManager(*mut c_void);
impl ActivationManager {
    fn vtbl(&self) -> &ApplicationActivationManagerVtbl {
        unsafe { &*((*(self.0 as *const ComObject)).vtbl as *const ApplicationActivationManagerVtbl) }
    }
}
impl Drop for ActivationManager {
    fn drop(&mut self) {
        unsafe { (self.vtbl().release)(self.0) };
    }
}

#[link(name = "ole32")]
extern "system" {
    fn CoInitializeEx(reserved: *mut c_void, coinit: u32) -> Hresult;
    fn CoUninitialize();
    fn CoCreateInstance(
        clsid: *const Guid,
        outer: *mut c_void,
        clsctx: u32,
        iid: *const Guid,
        out: *mut *mut c_void,
    ) -> Hresult;
}

#[link(name = "kernel32")]
extern "system" {
    fn OpenThread(access: u32, inherit: i32, thread_id: u32) -> Handle;
    fn ResumeThread(thread: Handle) -> u32;
    fn GetProcessIdOfThread(thread: Handle) -> u32;
    fn CloseHandle(handle: Handle) -> i32;
}

fn check(hr: Hresult, what: &str) -> Result<(), String> {
    if hr >= S_OK_MIN {
        Ok(())
    } else {
        Err(format!("{what} failed (HRESULT 0x{hr:08X})"))
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn base64_value(byte: u8) -> Result<u32, String> {
    match byte {
        b'A'..=b'Z' => Ok((byte - b'A') as u32),
        b'a'..=b'z' => Ok((byte - b'a' + 26) as u32),
        b'0'..=b'9' => Ok((byte - b'0' + 52) as u32),
        b'+' | b'-' => Ok(62),
        b'/' | b'_' => Ok(63),
        _ => Err(format!("Invalid base64 byte 0x{byte:02X}")),
    }
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &byte in input.as_bytes() {
        if byte == b'=' || byte == b'\r' || byte == b'\n' || byte == b' ' {
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

fn resume_thread(args: &[String]) -> Result<(), String> {
    let tid = args
        .windows(2)
        .find(|pair| pair[0] == "-tid")
        .and_then(|pair| pair[1].parse::<u32>().ok())
        .ok_or_else(|| "Missing AppX process/thread identity".to_string())?;
    let pid = args
        .windows(2)
        .find(|pair| pair[0] == "-p")
        .and_then(|pair| pair[1].parse::<u32>().ok())
        .ok_or_else(|| "Missing AppX process/thread identity".to_string())?;
    unsafe {
        let thread = OpenThread(THREAD_SUSPEND_RESUME | THREAD_QUERY_INFORMATION, 0, tid);
        if thread.is_null() {
            return Err("Cannot open AppX thread".to_string());
        }
        let result = (|| {
            if GetProcessIdOfThread(thread) != pid {
                return Err("AppX thread ownership mismatch".to_string());
            }
            if ResumeThread(thread) == u32::MAX {
                return Err("Cannot resume AppX thread".to_string());
            }
            Ok(())
        })();
        CloseHandle(thread);
        result
    }
}

fn co_create(clsid: &Guid, iid: &Guid) -> Result<*mut c_void, String> {
    let mut object: *mut c_void = std::ptr::null_mut();
    let hr = unsafe { CoCreateInstance(clsid, std::ptr::null_mut(), CLSCTX_ALL, iid, &mut object) };
    check(hr, "CoCreateInstance")?;
    if object.is_null() {
        return Err("CoCreateInstance returned no object".to_string());
    }
    Ok(object)
}

fn activate(args: &[String]) -> Result<u32, String> {
    if args.len() != 4 {
        return Err("Expected package, app ID, environment block and launch arguments".to_string());
    }
    let package = wide(&args[0]);
    let app_id = wide(&args[1]);
    let arguments = wide(&args[3]);
    // The launcher encodes the environment block as base64(utf16le double-null block).
    let raw = base64_decode(&args[2])?;
    let mut environment: Vec<u16> = raw
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    if !matches!(environment.as_slice(), [.., 0, 0]) {
        environment.push(0);
        environment.push(0);
    }

    let hr = unsafe { CoInitializeEx(std::ptr::null_mut(), COINIT_APARTMENTTHREADED) };
    check(hr, "CoInitializeEx")?;
    let result = (|| {
        let settings = DebugSettings(co_create(&CLSID_PACKAGE_DEBUG_SETTINGS, &IID_PACKAGE_DEBUG_SETTINGS)?);
        let activation = ActivationManager(co_create(
            &CLSID_APPLICATION_ACTIVATION_MANAGER,
            &IID_APPLICATION_ACTIVATION_MANAGER,
        )?);

        // Clear stale debugging configuration first; the result is ignored, matching appx.cs.
        settings.disable(package.as_ptr());
        let current = env::current_exe().map_err(|e| e.to_string())?;
        let debugger = wide(&format!("\"{}\" --resume", current.display()));
        check(
            unsafe {
                ((settings.vtbl()).enable_debugging)(
                    settings.0,
                    package.as_ptr(),
                    debugger.as_ptr(),
                    environment.as_ptr(),
                )
            },
            "EnableDebugging",
        )?;
        // Every path after EnableDebugging must restore DisableDebugging.
        let activation_result = (|| {
            let mut pid: u32 = 0;
            check(
                unsafe {
                    ((activation.vtbl()).activate_application)(
                        activation.0,
                        app_id.as_ptr(),
                        arguments.as_ptr(),
                        ACTIVATEOPTIONS_VALUE,
                        &mut pid,
                    )
                },
                "ActivateApplication",
            )?;
            Ok(pid)
        })();
        settings.disable(package.as_ptr());
        activation_result
    })();
    unsafe { CoUninitialize() };
    result
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--resume") {
        return match resume_thread(&args) {
            Ok(()) => ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("Harness Mix activation: {message}");
                ExitCode::FAILURE
            }
        };
    }
    match activate(&args) {
        Ok(pid) => {
            println!("{pid}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("Harness Mix activation: {message}");
            ExitCode::FAILURE
        }
    }
}
