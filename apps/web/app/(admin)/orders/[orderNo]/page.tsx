import { OrderDetail } from "../../../../components/order-detail";

export default async function Page({ params }: { params: Promise<{ orderNo: string }> }) {
  const { orderNo } = await params;
  return <OrderDetail orderNo={orderNo} />;
}
