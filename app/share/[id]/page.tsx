import { SharedWorkspace } from "@/components/SharedWorkspace";

export default async function SharedPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SharedWorkspace shareId={id} />;
}
