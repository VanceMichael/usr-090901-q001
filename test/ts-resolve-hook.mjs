// 测试用：Node strip-types 模式下把相对路径的 .js 说明符解析到 .ts 源文件。
// 生产运行使用 tsc 编译产物 dist/*.js，不需要此钩子。

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
    if (isRelative && specifier.endsWith(".js")) {
      return nextResolve(specifier.slice(0, -3) + ".ts", context);
    }
    throw error;
  }
}
