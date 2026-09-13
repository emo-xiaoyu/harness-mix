//! Windows Job Object helper: put this process (and every descendant it later
//! spawns) into a job carrying JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, so the whole
//! process tree dies with the shim no matter how the shim itself exits.
//!
//! Zero external crates on purpose: raw kernel32 FFI only, mirroring the
//! hand-written COM declarations in the appx crate.
#![cfg(windows)]

use std::ffi::c_void;

type Handle = *mut c_void;
type Bool = i32;

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;

#[repr(C)]
#[derive(Clone, Copy)]
struct IoCounters {
    read_operation_count: u64,
    write_operation_count: u64,
    other_operation_count: u64,
    read_transfer_count: u64,
    write_transfer_count: u64,
    other_transfer_count: u64,
}

#[repr(C)]
struct JobObjectBasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[repr(C)]
struct JobObjectExtendedLimitInformation {
    basic_limit_information: JobObjectBasicLimitInformation,
    io_info: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> Handle;
    fn SetInformationJobObject(job: Handle, info_class: i32, info: *mut c_void, length: u32) -> Bool;
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> Bool;
    fn GetCurrentProcess() -> Handle;
    fn GetLastError() -> u32;
}

/// Puts the current process into a fresh kill-on-close job. `Ok(())` means the
/// OS will now terminate every descendant of this process when it dies, for any
/// reason, including force-kill. Failure is advisory: callers keep running.
pub fn assign_kill_on_close() -> Result<(), String> {
    unsafe {
        let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
        if job.is_null() {
            return Err(format!("CreateJobObject failed ({})", GetLastError()));
        }
        let mut info: JobObjectExtendedLimitInformation = std::mem::zeroed();
        info.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let sized = std::mem::size_of::<JobObjectExtendedLimitInformation>() as u32;
        if SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS, &mut info as *mut _ as *mut c_void, sized) == 0 {
            return Err(format!("SetInformationJobObject failed ({})", GetLastError()));
        }
        if AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
            return Err(format!("AssignProcessToJobObject failed ({})", GetLastError()));
        }
        // The handle is intentionally leaked: the job must live exactly as long
        // as this process. The OS closes the handle on exit, which is what
        // triggers the kill of every remaining member.
        Ok(())
    }
}
