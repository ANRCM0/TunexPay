import { resolveAppVersion } from "../../../lib/app-version";

// 运行时版本探针：返回**当前这个进程**解析出的版本号，而不是构建时烘进前端的那个字符串。
// 用途是让左下角徽标在页面加载后自我校验——如果页面 HTML 来自旧版本（缓存、灰度、多副本），
// 徽标会立刻改口成真实在跑的那一版，避免「界面显示的版本号是假的」。
// APP_VERSION 在镜像里是 ENV（见 Dockerfile），因此这里读到的是部署时注入的发布版本号。
// force-dynamic 必须保留：否则 Next 会在构建期把它优化成静态结果，运行时取值就失效了。
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(resolveAppVersion(), { headers: { "Cache-Control": "no-store" } });
}
