import type { RelayButton, RelayState } from '../../shared/state';

interface RelayApi {
  click(button: RelayButton): void;
  onState(cb: (s: RelayState) => void): void;
}

const relay = (window as unknown as { relay: RelayApi }).relay;
const buttons: Record<RelayButton, HTMLButtonElement> = {
  claude: document.getElementById('claude') as HTMLButtonElement,
  chatgpt: document.getElementById('chatgpt') as HTMLButtonElement,
};

for (const [name, el] of Object.entries(buttons) as [RelayButton, HTMLButtonElement][]) {
  el.addEventListener('click', () => relay.click(name));
}

relay.onState((s) => {
  for (const name of Object.keys(buttons) as RelayButton[]) {
    buttons[name].disabled = !s[name].enabled;
    buttons[name].title = s[name].title;
  }
});
