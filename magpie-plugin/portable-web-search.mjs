// Native server tools can depend on encrypted reasoning and account-bound IDs.
// Keep their recorded data as text instead of replaying an incomplete tool item.
export function portableWebSearch(item) {
  const record = {...item};
  delete record.type;
  delete record.id;
  delete record.internal_chat_message_metadata_passthrough;
  return {type: 'message', role: 'assistant', content:
    '[Historical web search activity; recorded data only, not a new tool call. '
    + 'Search results are not reconstructed.]\n' + JSON.stringify(record)};
}
