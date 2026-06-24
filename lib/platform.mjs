// Single source of truth for OS branching. Mac-only glue (osascript, LaunchAgent,
// recursive fs.watch) gates on these instead of scattering process.platform checks.
export const isMac = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';
export const isWindows = process.platform === 'win32';
