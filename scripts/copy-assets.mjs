// 编译后把 SQL 迁移资源拷贝到 dist（tsc 不复制 .sql）
import { cpSync, mkdirSync } from "node:fs";
mkdirSync("dist/migrations", { recursive: true });
cpSync("src/migrations", "dist/migrations", { recursive: true });
console.log("migration assets copied");
