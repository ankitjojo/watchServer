// Asks for confirmation before submitting any form marked with data-confirm (no inline handlers: CSP).
document.addEventListener('submit', function (event) {
  var form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  var message = form.getAttribute('data-confirm');
  if (message && !window.confirm(message)) event.preventDefault();
});
