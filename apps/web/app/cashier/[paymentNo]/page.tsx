import { Cashier } from "../../../components/cashier";

export default async function Page({ params }: { params: Promise<{ paymentNo: string }> }) {
  const { paymentNo } = await params;
  return <Cashier paymentNo={paymentNo} />;
}
