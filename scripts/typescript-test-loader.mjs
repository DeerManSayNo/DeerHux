import { readFile, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

async function isFile(url) {
  try {
    return (await stat(fileURLToPath(url))).isFile();
  } catch {
    return false;
  }
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".ts") || url.endsWith(".tsx")) {
    const source = await readFile(fileURLToPath(url), "utf8");
    return {
      format: "module",
      source: ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          jsx: ts.JsxEmit.ReactJSX,
        },
        fileName: fileURLToPath(url),
      }).outputText,
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const projectUrl = new URL(`../${specifier.slice(2)}`, import.meta.url);
    for (const suffix of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      const candidate = pathToFileURL(`${fileURLToPath(projectUrl)}${suffix}`);
      if (await isFile(candidate)) return { url: candidate.href, shortCircuit: true };
    }
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!context.parentURL || !specifier.startsWith(".")) throw error;
    const base = new URL(specifier, context.parentURL);
    for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      const candidate = pathToFileURL(`${fileURLToPath(base)}${suffix}`);
      if (await isFile(candidate)) return { url: candidate.href, shortCircuit: true };
    }
    throw error;
  }
}
