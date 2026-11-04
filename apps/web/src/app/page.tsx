import { Empty, PageTitle, pageCls } from "@/components/ui";

export default function Home() {
  return (
    <div className={pageCls}>
      <PageTitle title="Contracts" />
      <Empty title="No contracts yet">Uploading arrives with the new reader.</Empty>
    </div>
  );
}
