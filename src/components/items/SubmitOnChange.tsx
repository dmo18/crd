"use client";

import type { ComponentProps } from "react";

/**
 * A select that sends its form as soon as a new choice is picked (the sort
 * of the Inventory list): no Search tap needed, and the choice goes into the
 * link like every other filter.
 */
export function SubmitOnChange(props: Omit<ComponentProps<"select">, "onChange">) {
  return <select {...props} onChange={(e) => e.currentTarget.form?.requestSubmit()} />;
}
