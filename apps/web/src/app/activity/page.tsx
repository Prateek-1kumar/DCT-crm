import { ActivityFeed } from "@/components/activity";
import { PageTitle, pageCls } from "@/components/ui";

export default function ActivityPage() {
  return (
    <div className={pageCls}>
      <PageTitle title="Activity" sub="Everything done on every contract, newest first." />
      <ActivityFeed />
    </div>
  );
}
