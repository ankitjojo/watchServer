// Opens/closes the "Deleted records" modal and powers the layout Back link (native <dialog>; no inline handlers: CSP).
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

// "Back" link (layout): return to the screen the user came from; the link's href (parent list) is the fallback
// for direct visits, new tabs and other sites. Same-origin, different-page referrer = real in-app history.
document.addEventListener('click', function (event) {
  var link = event.target instanceof Element ? event.target.closest('[data-back]') : null;
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  try {
    var from = new URL(document.referrer);
    if (from.origin === location.origin && from.pathname !== location.pathname && history.length > 1) {
      event.preventDefault();
      history.back();
    }
  } catch (e) {
    /* no/invalid referrer: follow the href */
  }
});
