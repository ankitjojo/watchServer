// Opens/closes the "Deleted records" modal (native <dialog>; no inline handlers: CSP).
// <dialog> already gives Esc, focus trap and focus return; we add the backdrop click.
document.addEventListener('click', function (event) {
  var target = event.target;
  if (!(target instanceof Element)) return;
  var opener = target.closest('[data-deleted-open]');
  if (opener) {
    var dialog = document.getElementById(opener.getAttribute('data-deleted-open'));
    if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
    return;
  }
  var closer = target.closest('[data-deleted-close]');
  if (closer) {
    closer.closest('dialog').close();
    return;
  }
  // The dialog fills the screen, so a click whose target is the dialog itself hit the backdrop.
  if (target instanceof HTMLDialogElement && target.classList.contains('deleted-dialog')) target.close();
});
