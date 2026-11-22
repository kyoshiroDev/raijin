module.exports = async function () {
  // Rien à tuer ici : Nx arrête lui-même la tâche continue `api:serve`.
  // (L'ancien `killPort` pouvait tuer un autre service de la machine écoutant sur le même port.)
  console.log(globalThis.__TEARDOWN_MESSAGE__);
};
