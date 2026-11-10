import { RoutedVersionShell } from "@/components/version/VersionShell";

export default function VersionLayout({ children }: LayoutProps<"/versions/[id]">) {
  return <RoutedVersionShell>{children}</RoutedVersionShell>;
}
