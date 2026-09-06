import { inflateRawSync } from 'node:zlib';
import { InvalidFileError } from '../util/errors.ts';

/**
 * A zip reader scoped to one job: pulling the `*.hdt` rules files out of a
 * HERO Designer jar.
 *
 * We read only entries whose names we ask for by hand, and we never write an
 * entry to a path taken from the archive, so archive-controlled paths cannot
 * escape anywhere. What is left to defend against is resource exhaustion, so
 * every entry is checked against a declared-size cap and a compression-ratio
 * cap before it is inflated.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_MARKER = 0xffff;

/** No .hdt in any shipped HERO Designer build is anywhere near this large. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** Text XML compresses well, but not a thousandfold. */
const MAX_COMPRESSION_RATIO = 200;

export interface ZipEntry {
  readonly name: string;
  readonly compressionMethod: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

export class ZipArchive {
  private constructor(
    private readonly data: Buffer,
    private readonly entries: ReadonlyMap<string, ZipEntry>,
    private readonly source: string,
  ) {}

  static open(data: Buffer | Uint8Array, source: string): ZipArchive {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return new ZipArchive(buffer, readCentralDirectory(buffer, source), source);
  }

  get names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Reads and decompresses one entry, or throws if it is missing. */
  read(name: string): Buffer {
    const entry = this.entries.get(name);
    if (entry === undefined) {
      throw new InvalidFileError(`This archive does not contain an entry named "${name}".`, {
        source: this.source,
      });
    }
    return this.inflate(entry);
  }

  private inflate(entry: ZipEntry): Buffer {
    if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
      throw new InvalidFileError(
        `The entry "${entry.name}" claims to be ${entry.uncompressedSize} bytes, which is larger than this tool will read.`,
        { source: this.source },
      );
    }
    if (
      entry.compressedSize > 0 &&
      entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO
    ) {
      throw new InvalidFileError(
        `The entry "${entry.name}" is compressed far more than any real rules file, so it will not be read.`,
        { source: this.source },
      );
    }

    const localStart = entry.localHeaderOffset;
    if (this.data.readUInt32LE(localStart) !== LOCAL_SIGNATURE) {
      throw new InvalidFileError(`The entry "${entry.name}" has a damaged header.`, { source: this.source });
    }
    const nameLength = this.data.readUInt16LE(localStart + 26);
    const extraLength = this.data.readUInt16LE(localStart + 28);
    const dataStart = localStart + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > this.data.length) {
      throw new InvalidFileError(`The entry "${entry.name}" extends past the end of the file.`, {
        source: this.source,
      });
    }

    const raw = this.data.subarray(dataStart, dataEnd);
    if (entry.compressionMethod === 0) {
      return Buffer.from(raw);
    }
    if (entry.compressionMethod !== 8) {
      throw new InvalidFileError(
        `The entry "${entry.name}" uses an unsupported compression method (${entry.compressionMethod}).`,
        { source: this.source },
      );
    }
    try {
      return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
    } catch (cause) {
      throw new InvalidFileError(`The entry "${entry.name}" could not be decompressed.`, {
        source: this.source,
        cause,
      });
    }
  }
}

function readCentralDirectory(data: Buffer, source: string): Map<string, ZipEntry> {
  const eocd = findEndOfCentralDirectory(data, source);
  const entryCount = data.readUInt16LE(eocd + 10);
  const directoryOffset = data.readUInt32LE(eocd + 16);

  if (entryCount === ZIP64_MARKER || directoryOffset === 0xffffffff) {
    throw new InvalidFileError(
      'This archive uses the ZIP64 format, which this tool does not read. ' +
        'HERO Designer jars are not ZIP64, so this is probably not a HERO Designer jar.',
      { source },
    );
  }

  const entries = new Map<string, ZipEntry>();
  let cursor = directoryOffset;
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > data.length || data.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new InvalidFileError('The archive directory is damaged and cannot be read.', { source });
    }
    const nameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const name = data.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    entries.set(name, {
      name,
      compressionMethod: data.readUInt16LE(cursor + 10),
      compressedSize: data.readUInt32LE(cursor + 20),
      uncompressedSize: data.readUInt32LE(cursor + 24),
      localHeaderOffset: data.readUInt32LE(cursor + 42),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(data: Buffer, source: string): number {
  // The record is 22 bytes plus a comment of up to 64 KiB, and sits at the end.
  const earliest = Math.max(0, data.length - 22 - 0xffff);
  for (let i = data.length - 22; i >= earliest; i--) {
    if (data.readUInt32LE(i) === EOCD_SIGNATURE) {
      return i;
    }
  }
  throw new InvalidFileError(
    'This file is not a readable archive. Please point at the HERO Designer jar file (usually HD6.jar).',
    { source },
  );
}
