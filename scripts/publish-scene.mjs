import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const [, , sourceArgument, slugArgument, ...titleParts] = process.argv;
if (!sourceArgument) {
  console.error("用法：npm run publish:scene -- <工程.gaussnav> [slug] [场景标题]");
  process.exit(1);
}

const source = resolve(sourceArgument);
const bytes = await readFile(source);
if (bytes.subarray(0, 9).toString() !== "GAUSSNAV1") {
  throw new Error("输入文件不是有效的 .gaussnav 工程");
}
const manifestLength = bytes.readUInt32LE(9);
const manifest = JSON.parse(bytes.subarray(13, 13 + manifestLength).toString("utf8"));
const fallbackSlug = basename(source, ".gaussnav")
  .normalize("NFKD")
  .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
  .replace(/^-|-$/g, "")
  .toLowerCase();
const slug = (slugArgument || fallbackSlug || `scene-${Date.now()}`)
  .replace(/[^a-zA-Z0-9-]/g, "-")
  .replace(/-+/g, "-")
  .replace(/^-|-$/g, "")
  .toLowerCase();
if (!slug) throw new Error("场景 slug 不能为空");
if (bytes.byteLength > 95 * 1024 * 1024) {
  throw new Error("工程超过 95 MB，不适合直接提交 GitHub；请改用对象存储");
}

const title = titleParts.join(" ").trim() || manifest.projectName || basename(source, ".gaussnav");
const outputDirectory = resolve("public-pages", "scenes", slug);
await mkdir(outputDirectory, { recursive: true });
await copyFile(source, resolve(outputDirectory, "project.gaussnav"));

const registryPath = resolve("public-pages", "scenes", "index.json");
const registry = JSON.parse(await readFile(registryPath, "utf8"));
const entry = {
  slug,
  title,
  projectUrl: `scenes/${slug}/project.gaussnav`,
  size: bytes.byteLength,
  routeNodes: Array.isArray(manifest.route) ? manifest.route.length : 0,
  poiCount: Array.isArray(manifest.pois) ? manifest.pois.length : 0,
  publishedAt: new Date().toISOString(),
};
const nextRegistry = [entry, ...registry.filter(scene => scene.slug !== slug)];
await writeFile(registryPath, `${JSON.stringify(nextRegistry, null, 2)}\n`);

console.log(`已准备场景：${title}`);
console.log(`独立地址：https://shengjuntang.github.io/Nav3DGS/?scene=${slug}`);
console.log("提交 public-pages/scenes 的变更并推送 main 后自动上线。");
