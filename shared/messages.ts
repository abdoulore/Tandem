// Messages a wallet signs; shared so the browser and server build byte-identical text.
export function intentMessage(owner: string, payload: unknown, ts: number): string {
  return `Tandem: authorize switch\nowner: ${owner}\nts: ${ts}\nintent: ${JSON.stringify(payload)}`;
}

export function fairMessage(owner: string, payload: unknown, ts: number): string {
  return `Tandem: authorize order\nowner: ${owner}\nts: ${ts}\norder: ${JSON.stringify(payload)}`;
}

export function telegramMessage(owner: string, ts: number): string {
  return `Tandem: send my switch alerts to Telegram\nowner: ${owner}\nts: ${ts}`;
}

export function cancelMessage(owner: string, id: string, ts: number): string {
  return `Tandem: cancel switch\nowner: ${owner}\nts: ${ts}\nid: ${id}`;
}
