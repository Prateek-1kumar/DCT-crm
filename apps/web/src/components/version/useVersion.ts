import { useQuery } from "@tanstack/react-query";
import { api, keys } from "@/lib/queries";

export const useVersion = (id: string, enabled = true) =>
  useQuery({ queryKey: keys.version(id), queryFn: () => api.version(id), enabled, refetchInterval: (q) => (q.state.data?.status === "reading" ? 3000 : false) });
