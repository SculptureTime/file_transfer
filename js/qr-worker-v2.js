"use strict";

importScripts("pako.min.js", "qrcode-generator.min.js", "jsQR.min.js");

function bytesToBinaryString(bytes) {
  let out = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    const chunk = bytes.subarray(i, Math.min(i + step, bytes.length));
    out += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return out;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeVarInt(value) {
  const bytes = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return bytes;
}

function createV5Frame(current, total, flags, payloadBytes) {
  const header = [0x46, 0x54, 0x05, flags, ...encodeVarInt(current), ...encodeVarInt(total)];
  const out = new Uint8Array(header.length + payloadBytes.length);
  out.set(header, 0);
  out.set(payloadBytes, header.length);
  return out;
}

function splitV5BinarySegments(metaBytes, payloadBytes, chunkSize) {
  const dataCount = Math.max(1, Math.ceil(payloadBytes.length / chunkSize));
  const total = dataCount + 1;
  const frames = [];
  frames.push(createV5Frame(1, total, 1, metaBytes));
  for (let i = 0; i < dataCount; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, payloadBytes.length);
    frames.push(createV5Frame(i + 2, total, 2, payloadBytes.slice(start, end)));
  }
  return frames;
}

function getChunkSizeByEcc(errorLevel) {
  const map = { L: 2800, M: 2200, Q: 1550, H: 1150 };
  return map[errorLevel] || 1550;
}

function isAlreadyCompressedFile(meta) {
  if (!meta) return false;
  const name = String(meta.name || "").toLowerCase();
  const mime = String(meta.type || "").toLowerCase();
  const compressedExt = /\.(jpg|jpeg|png|gif|webp|avif|heic|mp4|mp3|zip|rar|7z|gz|pdf|docx|xlsx|pptx)$/i;
  const compressedMime = /^(image\/(jpeg|png|gif|webp|avif|heic)|video\/|audio\/|application\/(zip|pdf|gzip))/;
  return compressedExt.test(name) || compressedMime.test(mime);
}

function shouldCompressFile(meta, bytes) {
  const mime = (meta.type || "").toLowerCase();
  const name = (meta.name || "").toLowerCase();
  const textType = mime.startsWith("text/") || /application\/(json|xml|javascript)/.test(mime);
  const textExt = /\.(txt|json|csv|xml|md|html|css|js|ts)$/i.test(name);
  if (isAlreadyCompressedFile(meta)) return false;
  if (textType || textExt) return true;
  return bytes.length > 512 * 1024;
}

function concatUint8Arrays(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function buildTransmission(input) {
  const {
    inputMode,
    fileBytesBuffer,
    text,
    fileMeta,
    forceCompress,
    maxFileSizeBytes,
    fileVolumeBytes,
    maxCompressedPreviewBytes,
    errorLevel,
  } = input;

  let sourceBytes;
  let meta;
  let strategyTag = "none";
  const useForce = Boolean(forceCompress);

  if (inputMode === "file") {
    const fileBytes = new Uint8Array(fileBytesBuffer || new ArrayBuffer(0));
    const safeMeta = fileMeta || { name: "file.bin", type: "application/octet-stream", size: fileBytes.length };
    if (!fileBytes.length) {
      throw new Error("empty_file");
    }
    if (fileBytes.length > maxFileSizeBytes) {
      throw new Error("file_too_large");
    }
    const alreadyCompressed = isAlreadyCompressedFile(safeMeta);
    const shouldCompress = shouldCompressFile(safeMeta, fileBytes);
    const enableMultipart = fileBytes.length > maxFileSizeBytes;

    if (enableMultipart) {
      const volumeParts = [];
      const volumeMeta = [];
      let offset = 0;
      let hasCompressedVolume = false;
      for (let start = 0; start < fileBytes.length; start += fileVolumeBytes) {
        const end = Math.min(start + fileVolumeBytes, fileBytes.length);
        const rawPart = fileBytes.slice(start, end);
        const deflated = pako.deflate(rawPart, { level: 9 });
        const useCompressed = useForce || deflated.length + 16 < rawPart.length;
        const partBytes = useCompressed ? deflated : rawPart;
        const partCompression = useCompressed ? "deflate" : "none";
        hasCompressedVolume = hasCompressedVolume || useCompressed;
        volumeParts.push(partBytes);
        volumeMeta.push({
          index: volumeMeta.length + 1,
          originalSize: rawPart.length,
          processedSize: partBytes.length,
          compression: partCompression,
          offset,
        });
        offset += partBytes.length;
      }
      sourceBytes = concatUint8Arrays(volumeParts);
      meta = {
        kind: "file",
        name: safeMeta.name || "file.bin",
        type: safeMeta.type || "application/octet-stream",
        size: Number.isFinite(safeMeta.size) ? safeMeta.size : fileBytes.length,
        compression: hasCompressedVolume ? "deflate" : "none",
        forceCompress: useForce,
        alreadyCompressed,
        originalSize: fileBytes.length,
        multipart: true,
        volumeSize: fileVolumeBytes,
        volumeCount: volumeMeta.length,
        volumes: volumeMeta,
      };
      strategyTag = useForce ? "force" : hasCompressedVolume ? "auto" : "none";
    } else {
      let finalBytes = fileBytes;
      let compression = "none";
      if (useForce || shouldCompress) {
        const deflated = pako.deflate(fileBytes, { level: 9 });
        if (useForce) {
          finalBytes = deflated;
          compression = "deflate";
        } else if (deflated.length + 16 < fileBytes.length) {
          finalBytes = deflated;
          compression = "deflate";
        }
      }
      sourceBytes = finalBytes;
      meta = {
        kind: "file",
        name: safeMeta.name || "file.bin",
        type: safeMeta.type || "application/octet-stream",
        size: Number.isFinite(safeMeta.size) ? safeMeta.size : fileBytes.length,
        compression,
        forceCompress: useForce,
        alreadyCompressed,
        originalSize: fileBytes.length,
        multipart: false,
      };
      strategyTag = useForce ? "force" : compression === "deflate" ? "auto" : "none";
    }
  } else {
    const encoded = new TextEncoder().encode(String(text || ""));
    let finalBytes = encoded;
    let compression = "none";
    if (useForce || encoded.length > 256) {
      const deflated = pako.deflate(encoded, { level: 9 });
      if (useForce) {
        finalBytes = deflated;
        compression = "deflate";
      } else if (deflated.length + 8 < encoded.length) {
        finalBytes = deflated;
        compression = "deflate";
      }
    }
    sourceBytes = finalBytes;
    meta = {
      kind: "text",
      compression,
      forceCompress: useForce,
      alreadyCompressed: false,
      originalSize: encoded.length,
      charset: "utf-8",
      multipart: false,
    };
    strategyTag = useForce ? "force" : compression === "deflate" ? "auto" : "none";
  }

  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const combined =
    sourceBytes.length <= maxCompressedPreviewBytes
      ? `v5t|${bytesToBase64Url(metaBytes)}|${bytesToBase64Url(sourceBytes)}`
      : "";
  const frames = splitV5BinarySegments(metaBytes, sourceBytes, getChunkSizeByEcc(errorLevel));
  const segmentBuffers = frames.map((frame) => frame.buffer);

  return {
    rawLength: inputMode === "file" ? new Uint8Array(fileBytesBuffer).length : new TextEncoder().encode(String(text || "")).length,
    processedLength: sourceBytes.length,
    strategy: strategyTag,
    forceCompress: meta.forceCompress,
    alreadyCompressed: meta.alreadyCompressed,
    combined,
    segmentBuffers,
  };
}

function renderMatrix(finalSize, moduleCount, isDark) {
  const matrix = new Uint8Array(moduleCount * moduleCount);
  let idx = 0;
  for (let r = 0; r < moduleCount; r++) {
    for (let c = 0; c < moduleCount; c++) {
      matrix[idx++] = isDark(r, c) ? 1 : 0;
    }
  }
  return matrix;
}

async function renderQrImage(payloadBuffer, finalSize, errorLevel) {
  const payloadBytes = new Uint8Array(payloadBuffer);
  const qr = qrcode(0, errorLevel);
  qr.addData(bytesToBinaryString(payloadBytes), "Byte");
  qr.make();

  const moduleCount = qr.getModuleCount();
  const padding = Math.max(48, Math.round(finalSize * 0.09765625));
  const qrArea = Math.max(128, finalSize - padding * 2);
  const cell = Math.max(1, Math.floor(qrArea / moduleCount));
  const drawSize = cell * moduleCount;
  const offsetX = Math.floor((finalSize - drawSize) / 2);
  const offsetY = Math.floor((finalSize - drawSize) / 2);

  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(finalSize, finalSize);
    const ctx = canvas.getContext("2d");
    if (ctx && typeof canvas.convertToBlob === "function") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, finalSize, finalSize);
      ctx.fillStyle = "#000000";
      for (let r = 0; r < moduleCount; r++) {
        for (let c = 0; c < moduleCount; c++) {
          if (qr.isDark(r, c)) {
            ctx.fillRect(offsetX + c * cell, offsetY + r * cell, cell, cell);
          }
        }
      }
      const blob = await canvas.convertToBlob({ type: "image/png" });
      const pngBuffer = await blob.arrayBuffer();
      return { kind: "png", pngBuffer };
    }
  }

  const matrix = renderMatrix(finalSize, moduleCount, qr.isDark.bind(qr));
  return { kind: "matrix", moduleCount, matrixBuffer: matrix.buffer, finalSize };
}

async function renderQrBatch(payloadBuffers, finalSize, errorLevel) {
  const items = [];
  const transfers = [];
  const list = Array.isArray(payloadBuffers) ? payloadBuffers : [];
  for (let i = 0; i < list.length; i++) {
    const payloadBuffer = list[i];
    const result = await renderQrImage(payloadBuffer, finalSize, errorLevel);
    if (result.kind === "png") {
      items.push({ kind: "png", pngBuffer: result.pngBuffer });
      transfers.push(result.pngBuffer);
    } else {
      items.push({
        kind: "matrix",
        matrixBuffer: result.matrixBuffer,
        moduleCount: result.moduleCount,
        finalSize: result.finalSize,
      });
      transfers.push(result.matrixBuffer);
    }
  }
  return { items, transfers };
}

function scanQr(imageBuffer, width, height) {
  const data = new Uint8ClampedArray(imageBuffer);
  const code = jsQR(data, width, height);
  if (!code) {
    throw new Error("qr_not_found");
  }
  const binary = code.binaryData ? Uint8Array.from(code.binaryData).buffer : null;
  return {
    text: code.data || "",
    binaryBuffer: binary,
  };
}

async function scanQrFile(fileBuffer) {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
    throw new Error("bitmap_decode_unsupported");
  }
  const blob = new Blob([fileBuffer]);
  const bitmap = await createImageBitmap(blob);
  try {
    const width = bitmap.width;
    const height = bitmap.height;
    if (!width || !height) {
      throw new Error("invalid_image_size");
    }
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new Error("canvas_context_unavailable");
    }
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, width, height);
    const imageBuffer = imageData.data.buffer.slice(
      imageData.data.byteOffset,
      imageData.data.byteOffset + imageData.data.byteLength
    );
    return scanQr(imageBuffer, width, height);
  } finally {
    if (typeof bitmap.close === "function") {
      bitmap.close();
    }
  }
}

self.onmessage = async (event) => {
  const { id, type, payload } = event.data || {};
  try {
    if (type === "buildTransmission") {
      const result = buildTransmission(payload || {});
      const transfers = result.segmentBuffers.slice();
      self.postMessage({ id, ok: true, result }, transfers);
      return;
    }

    if (type === "renderQr") {
      const result = await renderQrImage(payload.payloadBuffer, payload.finalSize, payload.errorLevel);
      if (result.kind === "png") {
        self.postMessage({ id, ok: true, result }, [result.pngBuffer]);
      } else {
        self.postMessage({ id, ok: true, result }, [result.matrixBuffer]);
      }
      return;
    }

    if (type === "renderQrBatch") {
      const batch = await renderQrBatch(payload.payloadBuffers, payload.finalSize, payload.errorLevel);
      self.postMessage(
        {
          id,
          ok: true,
          result: { items: batch.items },
        },
        batch.transfers
      );
      return;
    }

    if (type === "scanQr") {
      const result = scanQr(payload.imageBuffer, payload.width, payload.height);
      const transfers = [];
      if (result.binaryBuffer) transfers.push(result.binaryBuffer);
      self.postMessage({ id, ok: true, result }, transfers);
      return;
    }

    if (type === "scanQrFile") {
      const result = await scanQrFile(payload.fileBuffer);
      const transfers = [];
      if (result.binaryBuffer) transfers.push(result.binaryBuffer);
      self.postMessage({ id, ok: true, result }, transfers);
      return;
    }

    throw new Error("unknown_worker_action");
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  }
};
