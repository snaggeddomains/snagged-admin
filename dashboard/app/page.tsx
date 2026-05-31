import { redirect } from "next/navigation";

// The umbrella root currently lands on the Admin module. (A multi-module hub
// landing can replace this later.)
export default function Home() {
  redirect("/admin");
}
