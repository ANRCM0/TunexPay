import { Orders } from "../../../../components/orders";

export default async function Page({ params }: { params: Promise<{ orderNo: string }> }) {
  const { orderNo } = await params;
  return <Orders initialOrderNo={orderNo} />;
}
