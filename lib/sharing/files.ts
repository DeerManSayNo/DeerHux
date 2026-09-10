import fs from "node:fs";
import path from "node:path";

const MAX_BYTES = 200_000;
const BLOCKED = new Set(["node_modules", "vendor", "id_rsa", "id_ed25519"]);

/** No shell, link traversal, hidden files, special files or implicit directories. */
export class SharedFiles {
  readonly root: string;
  constructor(root: string, private readonly canWrite: () => boolean, private readonly authorize: () => void) {
    this.root = fs.realpathSync(root);
    if (!fs.statSync(this.root).isDirectory() || this.root === path.parse(this.root).root) throw new Error("请选择项目目录");
  }

  private resolve(relative: string, create = false): string {
    this.authorize();
    if (typeof relative !== "string" || relative.length > 1024 || /[\\\x00:]/.test(relative) || path.isAbsolute(relative)) throw new Error("只允许项目相对路径");
    const parts = relative === "." || relative === "" ? [] : relative.split("/");
    if (parts.some(p => !p || p.startsWith(".") || BLOCKED.has(p) || /\.(pem|key|p12|pfx)$/i.test(p))) throw new Error("路径不在分享范围内");
    if (fs.realpathSync(this.root) !== this.root) throw new Error("项目路径已改变");
    let target = this.root;
    for (let i = 0; i < parts.length; i++) {
      target = path.join(target, parts[i]);
      if (create && i === parts.length - 1 && !fs.existsSync(target)) break;
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw new Error("不允许链接或特殊文件");
      if (i < parts.length - 1 && !stat.isDirectory()) throw new Error("父路径不是目录");
    }
    return target;
  }

  list(relative = "."): string {
    const target = this.resolve(relative);
    return fs.readdirSync(target, { withFileTypes: true }).filter(entry => {
      try { this.resolve(relative === "." ? entry.name : `${relative}/${entry.name}`); return true; } catch { return false; }
    }).slice(0, 500).map(entry => `${entry.name}${entry.isDirectory() ? "/" : ""}`).join("\n");
  }

  read(relative: string): string {
    const target = this.resolve(relative);
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error("只支持 200KB 以内的普通文本文件");
      const bytes = fs.readFileSync(fd);
      if (bytes.includes(0)) throw new Error("不支持二进制文件");
      return bytes.toString("utf8");
    } finally { fs.closeSync(fd); }
  }

  write(relative: string, content: string): string {
    this.authorize();
    if (!this.canWrite()) throw new Error("主人未授予写入权限");
    if (typeof content !== "string" || Buffer.byteLength(content) > MAX_BYTES) throw new Error("文件内容不能超过 200KB");
    const target = this.resolve(relative, true);
    if (target === this.root) throw new Error("不能写入项目目录本身");
    // No O_TRUNC until the opened descriptor has been checked (including hard links).
    const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("不允许链接或特殊文件");
      fs.ftruncateSync(fd, 0);
      fs.writeFileSync(fd, content, "utf8");
    } finally { fs.closeSync(fd); }
    return `已写入 ${relative}`;
  }
}
