// Asks for confirmation before submitting any form marked with data-confirm (no inline handlers: CSP).
// Uses the shared Tabler/Bootstrap modal (#confirm-modal); falls back to window.confirm without it.
(function () {
  var element = document.getElementById('confirm-modal');
  var tabler = window.tabler || {};
  var Modal = tabler.Modal || (tabler.bootstrap && tabler.bootstrap.Modal) || (window.bootstrap && window.bootstrap.Modal);
  var modal = element && Modal ? Modal.getOrCreateInstance(element) : null;
  var message = element ? element.querySelector('[data-confirm-message]') : null;
  var accept = element ? element.querySelector('[data-confirm-accept]') : null;
  var pending = null;

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    var text = form.getAttribute('data-confirm');
    if (!text || form.getAttribute('data-confirmed') === 'true') return;
    event.preventDefault();
    if (!modal || !message || !accept) {
      if (window.confirm(text)) {
        form.setAttribute('data-confirmed', 'true');
        form.requestSubmit();
      }
      return;
    }
    pending = form;
    message.textContent = text;
    modal.show();
  });

  if (accept) {
    accept.addEventListener('click', function () {
      if (!pending) return;
      var form = pending;
      pending = null;
      form.setAttribute('data-confirmed', 'true');
      modal.hide();
      // requestSubmit fires the submit event again, so the loading state (ui.js) still applies.
      form.requestSubmit();
    });
  }
  if (element) {
    element.addEventListener('hidden.bs.modal', function () {
      pending = null;
    });
  }
})();
