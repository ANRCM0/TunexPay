import "./public.css";
import { ArcoProvider } from "../../components/arco-provider";

export default function PublicLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <ArcoProvider>{children}</ArcoProvider>;
}
