import type { Link, Parent, PhrasingContent, Root, Text } from "mdast";

// Keep this deliberately conservative. Candidates still pass through
// AiOutputLink's server-side existence and workspace access checks.
const FILE_PATH_PATTERN = /(?:[a-zA-Z]:[\\/]|[/\\]{1,2}|\.{1,2}[\\/])?(?:[\p{L}\p{N}_@+().-]+[\\/])+[\p{L}\p{N}_@+().-]+(?::\d+(?::\d+)?)?|(?:\.{1,2}[\\/])?[\p{L}\p{N}_@+()-]+(?:\.[a-zA-Z0-9_+-]+)+(?::\d+(?::\d+)?)?/gu;

export function isLocalPathCandidate(value: string): boolean {
  if (!value || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value) || /^(?:[a-z][a-z\d+.-]*:|#|\?)/i.test(value)) return false;
  const withoutLocation = value.replace(/#.*$/, "").replace(/:\d+(?::\d+)?$/, "");
  const name = withoutLocation.split(/[\\/]/).pop() ?? "";
  return /[\\/]/.test(withoutLocation) || /^\.[^./\\]+$/.test(name) || /\.[a-zA-Z0-9_+-]+$/.test(name);
}

function pathLink(value: string): Link {
  return { type: "link", url: value, children: [{ type: "text", value }] };
}

function linkTextPaths(node: Text): PhrasingContent[] {
  const children: PhrasingContent[] = [];
  let start = 0;

  for (const match of node.value.matchAll(FILE_PATH_PATTERN)) {
    const index = match.index;
    const value = match[0];
    if (index > start) children.push({ type: "text", value: node.value.slice(start, index) });
    children.push(pathLink(value));
    start = index + value.length;
  }

  if (start === 0) return [node];
  if (start < node.value.length) children.push({ type: "text", value: node.value.slice(start) });
  return children;
}

/** Turn agent-emitted bare file paths into links without touching code blocks or existing links. */
export function remarkLocalFileLinks() {
  return (tree: Root) => {
    const visit = (parent: Parent) => {
      for (let index = 0; index < parent.children.length; index += 1) {
        const node = parent.children[index];
        if (node.type === "link" || node.type === "image" || node.type === "code") continue;

        if (node.type === "inlineCode") {
          if (isLocalPathCandidate(node.value)) {
            parent.children[index] = {
              type: "link",
              url: node.value,
              children: [node],
            };
          }
          continue;
        }

        if (node.type === "text") {
          const replacements = linkTextPaths(node);
          parent.children.splice(index, 1, ...replacements);
          index += replacements.length - 1;
          continue;
        }

        if ("children" in node) visit(node as Parent);
      }
    };

    visit(tree);
  };
}
