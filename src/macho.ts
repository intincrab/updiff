const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const LC_ENCRYPTION_INFO = 0x21;
const LC_ENCRYPTION_INFO_64 = 0x2c;

/**
 * Whether a thin Mach-O image is FairPlay-encrypted, from its load commands
 * (LC_ENCRYPTION_INFO / _64 with a non-zero cryptid). `head` must hold the header
 * and the load commands; 64 KB covers real binaries. Returns undefined when `head`
 * isn't a little-endian Mach-O.
 *
 * Mac App Store apps for macOS are not encrypted; iPhone and iPad apps that run on
 * Apple silicon Macs are, and their strings can't be read.
 */
export function isEncryptedMachO(head: Buffer): boolean | undefined {
  if (head.length < 28) return undefined;
  const magic = head.readUInt32LE(0);
  if (magic !== MH_MAGIC && magic !== MH_MAGIC_64) return undefined;
  const ncmds = head.readUInt32LE(16);
  let offset = magic === MH_MAGIC_64 ? 32 : 28;
  for (let i = 0; i < ncmds && offset + 8 <= head.length; i++) {
    const cmd = head.readUInt32LE(offset);
    const size = head.readUInt32LE(offset + 4);
    if ((cmd === LC_ENCRYPTION_INFO || cmd === LC_ENCRYPTION_INFO_64) && offset + 20 <= head.length) {
      // struct encryption_info_command { cmd, cmdsize, cryptoff, cryptsize, cryptid }
      if (head.readUInt32LE(offset + 16) !== 0) return true;
    }
    if (size < 8) break;
    offset += size;
  }
  return false;
}
