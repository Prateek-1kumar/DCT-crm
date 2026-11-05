import { QuestionsView } from "@/components/version/QuestionsView";

export default async function QuestionsPage({ params }: PageProps<"/versions/[id]/questions">) {
  const { id } = await params;
  return <QuestionsView versionId={id} />;
}
