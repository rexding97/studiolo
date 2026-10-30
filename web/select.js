(function (root) {
  "use strict";

  var records = [];
  var observer = null;

  function findRecord(select) {
    for (var i = 0; i < records.length; i += 1) {
      if (records[i].select === select) return records[i];
    }
    return null;
  }

  function dispatchNative(select, type) {
    var event;
    if (typeof Event === "function") {
      event = new Event(type, { bubbles: true });
    } else {
      event = document.createEvent("Event");
      event.initEvent(type, true, false);
    }
    select.dispatchEvent(event);
  }

  function optionLabel(select) {
    var option = select.options[select.selectedIndex];
    return option ? option.text : (select.getAttribute("aria-label") || "请选择");
  }

  function accessibleLabel(select) {
    if (select.getAttribute("aria-label")) return select.getAttribute("aria-label");
    if (select.id) {
      var label = document.querySelector('label[for="' + select.id + '"]');
      if (label && label.textContent.trim()) return label.textContent.trim();
    }
    return "选择选项";
  }

  function setActive(record, index, focusMenu) {
    var options = record.select.options;
    if (!options.length) return;
    var next = Math.max(0, Math.min(options.length - 1, index));
    var direction = next < record.activeIndex ? -1 : 1;
    while (options[next] && options[next].disabled && next > 0 && next < options.length - 1) next += direction;
    if (options[next] && options[next].disabled) {
      for (var i = 0; i < options.length; i += 1) {
        if (!options[i].disabled) {
          next = i;
          break;
        }
      }
    }
    record.activeIndex = next;
    record.optionElements.forEach(function (element, optionIndex) {
      var active = optionIndex === next;
      element.classList.toggle("active", active);
      element.setAttribute("aria-selected", active ? "true" : "false");
    });
    if (record.optionElements[next]) {
      record.menu.setAttribute("aria-activedescendant", record.optionElements[next].id);
      if (focusMenu) record.menu.focus({ preventScroll: true });
      record.optionElements[next].scrollIntoView({ block: "nearest" });
    }
  }

  function close(record, restoreFocus) {
    if (!record.open) return;
    record.open = false;
    record.trigger.setAttribute("aria-expanded", "false");
    record.menu.hidden = true;
    record.wrapper.classList.remove("open", "drop-up");
    if (restoreFocus) record.trigger.focus({ preventScroll: true });
  }

  function closeOthers(except) {
    records.forEach(function (record) {
      if (record !== except) close(record, false);
    });
  }

  function choose(record, index) {
    var option = record.select.options[index];
    if (!option || option.disabled || record.select.disabled) return;
    record.select.selectedIndex = index;
    record.select.value = option.value;
    record.triggerText.textContent = optionLabel(record.select);
    dispatchNative(record.select, "input");
    dispatchNative(record.select, "change");
    close(record, true);
  }

  function buildOptions(record) {
    record.menu.innerHTML = "";
    record.optionElements = [];
    record.uid += 1;
    Array.prototype.forEach.call(record.select.options, function (option, index) {
      var element = document.createElement("button");
      element.type = "button";
      element.className = "st-select-option";
      element.id = record.id + "-option-" + record.uid + "-" + index;
      element.setAttribute("role", "option");
      element.setAttribute("aria-selected", option.selected ? "true" : "false");
      element.tabIndex = -1;
      element.disabled = option.disabled;
      var label = document.createElement("span");
      label.className = "st-select-option-label";
      label.textContent = option.text;
      var check = document.createElement("span");
      check.className = "st-select-check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = option.selected ? "✓" : "";
      element.appendChild(label);
      element.appendChild(check);
      element.addEventListener("click", function () { choose(record, index); });
      record.menu.appendChild(element);
      record.optionElements.push(element);
    });
    record.triggerText.textContent = optionLabel(record.select);
    record.activeIndex = Math.max(0, record.select.selectedIndex);
    setActive(record, record.activeIndex, false);
  }

  function placeMenu(record) {
    record.wrapper.classList.remove("drop-up");
    var rect = record.wrapper.getBoundingClientRect();
    var estimated = Math.min(280, record.select.options.length * 42 + 18);
    var below = root.innerHeight - rect.bottom;
    if (below < estimated && rect.top > below) record.wrapper.classList.add("drop-up");
  }

  function open(record) {
    if (record.select.disabled) return;
    closeOthers(record);
    buildOptions(record);
    record.open = true;
    record.trigger.disabled = false;
    record.trigger.setAttribute("aria-expanded", "true");
    record.menu.hidden = false;
    record.wrapper.classList.add("open");
    placeMenu(record);
    setActive(record, record.select.selectedIndex < 0 ? 0 : record.select.selectedIndex, true);
  }

  function toggle(record) {
    if (record.open) close(record, true);
    else open(record);
  }

  function moveActive(record, delta) {
    var count = record.select.options.length;
    if (!count) return;
    var next = record.activeIndex;
    for (var i = 0; i < count; i += 1) {
      next = (next + delta + count) % count;
      if (!record.select.options[next].disabled) break;
    }
    setActive(record, next, true);
  }

  function enhance(select) {
    if (!select || select.tagName !== "SELECT") return null;
    var existing = findRecord(select);
    if (existing) return existing;
    var wrapper = document.createElement("div");
    wrapper.className = "st-select";
    if (select.id === "workspaceSelect") wrapper.classList.add("st-select-workspace");
    select.parentNode.insertBefore(wrapper, select);
    wrapper.appendChild(select);
    select.classList.add("st-select-native");
    select.setAttribute("aria-hidden", "true");
    select.tabIndex = -1;

    var trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "st-select-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-label", accessibleLabel(select));
    var text = document.createElement("span");
    text.className = "st-select-value";
    text.textContent = optionLabel(select);
    var chevron = document.createElement("span");
    chevron.className = "st-select-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "⌄";
    trigger.appendChild(text);
    trigger.appendChild(chevron);

    var menu = document.createElement("div");
    menu.className = "st-select-menu";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", accessibleLabel(select));
    menu.tabIndex = 0;
    menu.hidden = true;
    wrapper.appendChild(trigger);
    wrapper.appendChild(menu);

    var record = {
      select: select,
      wrapper: wrapper,
      trigger: trigger,
      triggerText: text,
      menu: menu,
      optionElements: [],
      activeIndex: 0,
      open: false,
      id: "st-select-" + records.length,
      uid: 0
    };
    records.push(record);
    select.setAttribute("data-st-select-enhanced", "true");
    trigger.disabled = select.disabled;
    wrapper.classList.toggle("disabled", select.disabled);

    trigger.addEventListener("click", function () { toggle(record); });
    trigger.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (!record.open) open(record);
        if (event.key === "ArrowUp") moveActive(record, -1);
        else if (event.key === "ArrowDown") moveActive(record, 1);
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        if (!record.open) open(record);
        setActive(record, event.key === "Home" ? 0 : record.select.options.length - 1, true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        close(record, true);
      }
    });
    menu.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        moveActive(record, event.key === "ArrowDown" ? 1 : -1);
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        setActive(record, event.key === "Home" ? 0 : record.select.options.length - 1, true);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        choose(record, record.activeIndex);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(record, true);
      } else if (event.key === "Tab") {
        close(record, false);
      }
    });
    select.addEventListener("input", function () { buildOptions(record); });
    select.addEventListener("change", function () { buildOptions(record); });
    buildOptions(record);
    return record;
  }

  function enhanceAll(container) {
    var selects = (container || document).querySelectorAll("select");
    Array.prototype.forEach.call(selects, enhance);
  }

  function refresh(select) {
    var record = findRecord(select) || enhance(select);
    if (!record) return;
    record.trigger.disabled = record.select.disabled;
    record.wrapper.classList.toggle("disabled", record.select.disabled);
    if (record.select.disabled) close(record, false);
    buildOptions(record);
    if (record.open) placeMenu(record);
  }

  function watch() {
    if (observer || typeof MutationObserver !== "function") return;
    observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        if (mutation.type === "attributes" && (mutation.target.tagName === "SELECT" || mutation.target.tagName === "OPTION")) {
          refresh(mutation.target.tagName === "OPTION" ? mutation.target.parentNode : mutation.target);
        }
        if (mutation.type === "childList") {
          enhanceAll(mutation.target);
          if (mutation.target.tagName === "SELECT") refresh(mutation.target);
        }
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
  }

  document.addEventListener("pointerdown", function (event) {
    records.forEach(function (record) {
      if (record.open && !record.wrapper.contains(event.target)) close(record, false);
    });
  }, true);
  document.addEventListener("focusin", function (event) {
    records.forEach(function (record) {
      if (record.open && !record.wrapper.contains(event.target)) close(record, false);
    });
  });
  root.addEventListener("resize", function () {
    records.forEach(function (record) {
      if (record.open) placeMenu(record);
    });
  });
  document.addEventListener("DOMContentLoaded", function () {
    enhanceAll(document);
    watch();
  });

  root.StudioloSelect = Object.freeze({
    enhance: enhance,
    enhanceAll: enhanceAll,
    refresh: refresh,
    closeAll: function () { closeOthers(null); },
    runTests: function () {
      if (!root.document) throw new Error("需要浏览器 DOM");
      var select = document.createElement("select");
      select.setAttribute("aria-label", "自测下拉");
      ["一", "二", "三"].forEach(function (name) {
        var option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        select.appendChild(option);
      });
      document.body.appendChild(select);
      var record = enhance(select);
      var changes = 0;
      select.addEventListener("change", function () { changes += 1; });
      open(record);
      choose(record, 1);
      var passed = select.value === "二" && changes === 1 && !record.open && record.trigger.getAttribute("aria-expanded") === "false";
      record.wrapper.remove();
      return { passed: passed ? 1 : 0, failed: passed ? 0 : 1 };
    }
  });
})(typeof window !== "undefined" ? window : globalThis);
