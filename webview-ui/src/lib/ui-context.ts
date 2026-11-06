import { createContext } from "react";

/** Lets a chat tool card jump to the approval queue (switches tab in the narrow layout). */
export const ShowQueueContext = createContext<() => void>(() => {});
