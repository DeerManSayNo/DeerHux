import { Suspense } from "react";
import { SelectionAssistantWindow } from "@/components/SelectionAssistantWindow";

export default function SelectionAssistantPage() {
  return (
    <Suspense>
      <SelectionAssistantWindow />
    </Suspense>
  );
}
