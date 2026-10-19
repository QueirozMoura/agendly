import { v7 } from "uuid";

/** UUID v7 gerado pela aplicação, para quando o ID é necessário antes do INSERT (V2). */
export function newId(): string {
  return v7();
}
