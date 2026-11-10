import { ApprovePanel } from "@/components/version/ApprovePanel";

export default async function ApprovePage({ params }: PageProps<"/versions/[id]/approve">) {
  const { id } = await params;
  return <ApprovePanel versionId={id} />;
}
