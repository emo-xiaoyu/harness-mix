/**
 * Codex Desktop only renders text for the Command Execution lane, so model
 * reasoning is projected as a command execution carrying this sentinel.
 * Transcript projection and the renderer summary both key off it.
 */
export const REASONING_TRANSCRIPT_COMMAND = "thinking";
