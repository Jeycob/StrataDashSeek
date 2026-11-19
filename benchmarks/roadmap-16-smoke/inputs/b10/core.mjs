export function searchNotes(notes, query) {
  return notes.filter(note => `${note.title} ${note.body}`.includes(query));
}
export function updateNote(note, input) {
  note.title = input.title;
  note.body = input.body;
  note.version += 1;
  return { ...note };
}
