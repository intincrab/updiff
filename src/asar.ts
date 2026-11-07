import { closeSync, existsSync, openSync, readSync, readFileSync } from 'node:fs';

export interface AsarFile {
  /** Path inside the archive, with forward slashes and no leading slash. */
  path: string;
  size: number;
  offset: number;
  unpacked: boolean;
  executable: boolean;
}

interface HeaderNode {
  files?: Record<string, HeaderNode>;
  size?: number;
  offset?: string;
  unpacked?: boolean;
  executable?: boolean;
  link?: string;
}

/**
 * Reads Electron `.asar` archives without extracting them.
 *
 * Layout: an 8-byte pickle that holds the header size, then a pickle whose payload is
 * a length-prefixed JSON header, then the file data. A file's `offset` counts from the
 * start of the data. Files marked `unpacked` live in `<archive>.unpacked/`.
 */
export class AsarArchive {
  readonly path: string;
  readonly header: HeaderNode;
  private readonly dataOffset: number;
  private fd: number;

  private constructor(path: string, fd: number, header: HeaderNode, dataOffset: number) {
    this.path = path;
    this.fd = fd;
    this.header = header;
    this.dataOffset = dataOffset;
  }

  static open(path: string): AsarArchive {
    const fd = openSync(path, 'r');
    try {
      const sizeBuf = Buffer.alloc(8);
      if (readSync(fd, sizeBuf, 0, 8, 0) !== 8) throw new Error('File is too small to be an asar archive');
      const headerPickleSize = sizeBuf.readUInt32LE(4);
      if (headerPickleSize < 8 || headerPickleSize > 512 * 1024 * 1024) throw new Error('Invalid asar header size');
      const headerBuf = Buffer.alloc(headerPickleSize);
      if (readSync(fd, headerBuf, 0, headerPickleSize, 8) !== headerPickleSize) throw new Error('Truncated asar header');
      const jsonLength = headerBuf.readUInt32LE(4);
      if (jsonLength > headerPickleSize - 8) throw new Error('Invalid asar header length');
      const header = JSON.parse(headerBuf.toString('utf8', 8, 8 + jsonLength)) as HeaderNode;
      if (!header.files) throw new Error('asar header has no files');
      return new AsarArchive(path, fd, header, 8 + headerPickleSize);
    } catch (err) {
      closeSync(fd);
      throw err;
    }
  }

  *files(): Generator<AsarFile> {
    const stack: Array<[string, HeaderNode]> = [['', this.header]];
    while (stack.length) {
      const [prefix, node] = stack.pop()!;
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (child.files) stack.push([path, child]);
        else if (child.link === undefined) {
          yield {
            path,
            size: child.size ?? 0,
            offset: Number(child.offset ?? 0),
            unpacked: child.unpacked === true,
            executable: child.executable === true,
          };
        }
      }
    }
  }

  /** Reads a file's bytes, or the first `limit` bytes. */
  read(file: AsarFile, limit = Infinity): Buffer {
    const length = Math.min(file.size, limit);
    if (file.unpacked) {
      const unpackedPath = `${this.path}.unpacked/${file.path}`;
      if (!existsSync(unpackedPath)) return Buffer.alloc(0);
      const buf = readFileSync(unpackedPath);
      return length < buf.length ? buf.subarray(0, length) : buf;
    }
    const buf = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(this.fd, buf, read, length - read, this.dataOffset + file.offset + read);
      if (n === 0) break;
      read += n;
    }
    return read < length ? buf.subarray(0, read) : buf;
  }

  close(): void {
    if (this.fd >= 0) {
      closeSync(this.fd);
      this.fd = -1;
    }
  }
}
