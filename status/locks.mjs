// Tells whether the runner holds its lock and since when. ticket-runner opens `<state>/lock` as fd 9 and takes a flock
// on it with flock(1) on every timer start, so the file always exists; only the kernel's lock table says whether it is
// held. The pid that table names is flock(1)'s, which exits at once, so the holder is found as the processes that still
// have the file open: the runner and the children that inherit fd 9.
import fs from 'node:fs';
import path from 'node:path';

/** Linux reports process start times in clock ticks of 1/100 s (`getconf CLK_TCK`). */
const ticksPerSecond = 100;

/**
 * Parses /proc/locks into `{major, minor, inode}` entries. The device is printed as hex `major:minor`; blocked waiters
 * (`->`) are skipped because they do not hold the lock.
 * @param {string} text
 */
export function parseProcLocks(text) {
  const held = [];
  for (const line of text.split('\n')) {
    if (line.includes('->')) continue;
    const match = /\s([0-9a-f]+):([0-9a-f]+):(\d+)\s/i.exec(line);
    if (match) held.push({major: parseInt(match[1], 16), minor: parseInt(match[2], 16), inode: BigInt(match[3])});
  }
  return held;
}

/**
 * Splits a Linux `dev_t` into major and minor numbers (glibc's encoding).
 * @param {bigint} dev
 */
export function deviceNumbers(dev) {
  const major = Number(((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn));
  const minor = Number((dev & 0xffn) | ((dev >> 12n) & ~0xffn));
  return {major, minor};
}

/**
 * Whether `/proc/locks` text lists a lock on the file with this device and inode.
 * @param {string} procLocks
 * @param {{dev: bigint, ino: bigint}} file
 */
export function isLocked(procLocks, file) {
  const {major, minor} = deviceNumbers(file.dev);
  return parseProcLocks(procLocks).some(lock => lock.major === major && lock.minor === minor && lock.inode === file.ino);
}

/**
 * When a process started, in epoch milliseconds, from its `/proc/<pid>/stat` text and the boot time in seconds.
 * Field 22 (starttime) counts clock ticks since boot; the command name in field 2 can hold spaces and parentheses.
 * @param {string} stat
 * @param {number} bootSeconds
 */
export function processStartMs(stat, bootSeconds) {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = Number(fields[22 - 3]);
  return Number.isInteger(ticks) ? (bootSeconds + ticks / ticksPerSecond) * 1000 : null;
}

/**
 * Whether the runner's lock file is held (true or false, or null when the lock table cannot be read: not Linux, or no
 * lock file yet) and, when held, when the earliest live process that has the file open started (null when unknown).
 * @param {string} lockPath
 * @param {string} [procRoot]
 * @returns {{held: boolean | null, holderStartMs: number | null}}
 */
export function lockState(lockPath, procRoot = '/proc') {
  let held;
  try {
    const file = fs.statSync(lockPath, {bigint: true});
    held = isLocked(fs.readFileSync(path.join(procRoot, 'locks'), 'utf8'), file);
  } catch {
    return {held: null, holderStartMs: null};
  }
  return {held, holderStartMs: held ? holderStartMs(lockPath, procRoot) : null};
}

/**
 * @param {string} lockPath
 * @param {string} procRoot
 */
function holderStartMs(lockPath, procRoot) {
  try {
    const target = fs.realpathSync(lockPath);
    const boot = /^btime (\d+)$/m.exec(fs.readFileSync(path.join(procRoot, 'stat'), 'utf8'));
    if (!boot) return null;
    /** @type {number | null} */
    let earliest = null;
    for (const pid of fs.readdirSync(procRoot).filter(name => /^\d+$/.test(name))) {
      try {
        const fdDir = path.join(procRoot, pid, 'fd');
        if (!fs.readdirSync(fdDir).some(fd => fs.readlinkSync(path.join(fdDir, fd)) === target)) continue;
        const started = processStartMs(fs.readFileSync(path.join(procRoot, pid, 'stat'), 'utf8'), Number(boot[1]));
        if (started !== null && (earliest === null || started < earliest)) earliest = started;
      } catch {
        // Gone, or another user's process: not the runner's.
      }
    }
    return earliest;
  } catch {
    return null;
  }
}
