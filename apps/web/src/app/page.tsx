import { redirect } from "next/navigation";
import { getRefreshToken } from "../lib/session";

export default async function RootPage() {
  redirect((await getRefreshToken()) ? "/dashboard" : "/login");
}
