import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { canEnterDeals } from "@/lib/permissions";
import OwnerClient from "./owner-client";

export const dynamic = "force-dynamic";

export default async function OwnerDetailPage({ params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/deals/owners/${params.id}`);
  if (!canEnterDeals(user)) return <main><h1 style={{ fontSize: "1.25rem" }}>No access</h1></main>;
  return <OwnerClient id={params.id} />;
}
