"use client";

import wasmUrl from "@playcanvas/splat-transform/lib/webp.wasm?url";

const SOG_MIME = "application/x-playcanvas-sog";

export function isSogFile(file: File) {
  return file.name.toLowerCase().endsWith(".sog");
}

export async function convertPlyToSog(file: File): Promise<File> {
  if (isSogFile(file)) return file;
  if (!file.name.toLowerCase().endsWith(".ply")) {
    throw new Error("请选择 PLY 或 SOG 场景文件");
  }

  const {
    MemoryFileSystem,
    MemoryReadFileSystem,
    WebPCodec,
    WorkerQueue,
    createChunkDataPool,
    getInputFormat,
    getOutputFormat,
    processSource,
    readFile,
    writeSource
  } = await import("@playcanvas/splat-transform");

  // The codec and worker paths must be explicit in a browser bundle. Inline
  // encoding also avoids duplicating a large PLY buffer across web workers.
  WebPCodec.wasmUrl = wasmUrl;
  WorkerQueue.maxWorkers = 0;

  const inputName = "scene.ply";
  const outputName = `${file.name.replace(/\.ply$/i, "")}.sog`;
  const input = new MemoryReadFileSystem();
  input.set(inputName, new Uint8Array(await file.arrayBuffer()));

  const [source] = await readFile({
    filename: inputName,
    inputFormat: getInputFormat(inputName),
    fileSystem: input
  });
  if (!source.meta.availableLayers.has("position") ||
      !source.meta.availableLayers.has("geometric") ||
      !source.meta.availableLayers.has("color")) {
    await source.close();
    throw new Error("该 PLY 是普通点云，不包含完整的 3D Gaussian Splat 数据");
  }

  const pool = createChunkDataPool();
  const cleaned = await processSource(source, [{ kind: "filterNaN" }], pool);
  const output = new MemoryFileSystem();

  try {
    await writeSource({
      filename: outputName,
      outputFormat: getOutputFormat(outputName, {}),
      source: cleaned,
      pool,
      options: { iterations: 10 }
    }, output);
  } finally {
    await cleaned.close();
    if (cleaned !== source) await source.close();
  }

  const bytes = output.results.get(outputName);
  if (!bytes?.byteLength) throw new Error("SOG 转换没有生成有效输出");
  const fileBuffer = new Uint8Array(bytes.byteLength);
  fileBuffer.set(bytes);
  return new File([fileBuffer.buffer], outputName, { type: SOG_MIME, lastModified: Date.now() });
}
