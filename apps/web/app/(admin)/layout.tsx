import "./admin.css";
import { Shell } from "../../components/shell";

export default function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <Shell>{children}</Shell>;
}
