import { VersionShell } from "@/components/version/VersionShell";

export default async function VersionLayout({ children, params }: LayoutProps<"/versions/[id]">) {
  const { id } = await params;
  return <VersionShell versionId={id}>{children}</VersionShell>;
}
