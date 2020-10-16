import "../../components/ha-circular-progress";
import "../../components/ha-header-bar";
import "@material/mwc-list/mwc-list-item";
import "@material/mwc-list/mwc-list";
import {
  css,
  customElement,
  html,
  internalProperty,
  LitElement,
  property,
  PropertyValues,
  query,
} from "lit-element";
import { fireEvent } from "../../common/dom/fire_event";
import "../../components/ha-dialog";
import { haStyleDialog } from "../../resources/styles";
import { HomeAssistant, ServiceCallRequest } from "../../types";
import { fuzzySequentialMatch } from "../../common/string/sequence_matching";
import { componentsWithService } from "../../common/config/components_with_service";
import { domainIcon } from "../../common/entity/domain_icon";
import { computeDomain } from "../../common/entity/compute_domain";
import { domainToName } from "../../data/integration";
import { QuickBarParams } from "./show-dialog-quick-bar";
import { HassEntity } from "home-assistant-js-websocket";
import { compare } from "../../common/string/compare";
import { SingleSelectedEvent } from "@material/mwc-list/mwc-list-foundation";
import memoizeOne from "memoize-one";
import "../../common/search/search-input";
import { mdiConsoleLine } from "@mdi/js";
import { debounce } from "../../common/util/debounce";
import { scroll } from "lit-virtualizer";
import { styleMap } from "lit-html/directives/style-map";

interface CommandItem extends ServiceCallRequest {
  text: string;
}

@customElement("ha-quick-bar")
export class QuickBar extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;

  @internalProperty() private _commandItems?: CommandItem[];

  @internalProperty() private _entities?: HassEntity[];

  @internalProperty() private _filter = "";

  @internalProperty() private _filteredItems?: CommandItem[] | HassEntity[];

  @internalProperty() private _opened = false;

  @internalProperty() private _commandMode = false;

  @internalProperty() private _commandTriggered = -1;

  @internalProperty() private _activatedIndex = 0;

  @query("search-input", false) private _filterInputField?: HTMLElement;

  @query("mwc-list-item", false) private _firstListItem?: HTMLElement;

  public async showDialog(params: QuickBarParams) {
    this._commandMode = params.commandMode || false;
    this._commandItems = this._generateCommandItems();
    this._entities = Object.keys(this.hass.states).map<HassEntity>(
      (entity_id) => this.hass.states[entity_id]
    );
    this._opened = true;
  }

  public closeDialog() {
    this._opened = false;
    this._filter = "";
    this._commandTriggered = -1;
    this._commandItems = undefined;
    this._entities = undefined;
    this._filteredItems = undefined;
    this._resetActivatedIndex();
    fireEvent(this, "dialog-closed", { dialog: this.localName });
  }

  protected updated(changedProperties: PropertyValues) {
    if (
      this._opened &&
      (changedProperties.has("_opened") ||
        changedProperties.has("_filter") ||
        changedProperties.has("_commandMode"))
    ) {
      this._setFilteredItems();
    }
  }

  protected render() {
    if (!this._opened) {
      return html``;
    }

    return html`
      <ha-dialog .heading=${true} open @closed=${this.closeDialog} hideActions>
        <search-input
          dialogInitialFocus
          no-label-float
          slot="heading"
          class="heading"
          @value-changed=${this._handleSearchChange}
          .label=${this.hass.localize(
            "ui.dialogs.quick-bar.filter_placeholder"
          )}
          .filter=${this._commandMode ? `>${this._filter}` : this._filter}
          @keydown=${this._handleInputKeyDown}
          @focus=${this._resetActivatedIndex}
        >
          ${this._commandMode
            ? html`<ha-svg-icon
                slot="prefix"
                class="prefix"
                .path=${mdiConsoleLine}
              ></ha-svg-icon>`
            : ""}
        </search-input>
        ${!this._filteredItems
          ? html`<ha-circular-progress
              size="small"
              active
            ></ha-circular-progress>`
          : html`<mwc-list
              activatable
              @selected=${this._commandMode
                ? this._processCommand
                : this._entityMoreInfo}
              style=${styleMap({
                height: `${Math.min(
                  this._filteredItems.length * 72 + 26,
                  500
                )}px`,
              })}
            >
              ${scroll({
                items: this._filteredItems as [],
                renderItem: (item: HassEntity | CommandItem, index?: number) =>
                  this._commandMode
                    ? this._renderCommandItem(item as CommandItem, index)
                    : this._renderEntityItem(item as HassEntity, index),
              })}
            </mwc-list>`}
      </ha-dialog>
    `;
  }

  protected _renderCommandItem(item: CommandItem, index?: number) {
    return html`
      <mwc-list-item
        .activated=${index === this._activatedIndex}
        .item=${item}
        .index=${index}
        @keydown=${this._handleListItemKeyDown}
        hasMeta
        graphic="icon"
      >
        <ha-icon .icon=${domainIcon(item.domain)} slot="graphic"></ha-icon>
        ${item.text}
        ${this._commandTriggered === index
          ? html`<ha-circular-progress
              size="small"
              active
              slot="meta"
            ></ha-circular-progress>`
          : null}
      </mwc-list-item>
    `;
  }

  private _renderEntityItem(entity: HassEntity, index?: number) {
    const domain = computeDomain(entity.entity_id);
    return html`
      <mwc-list-item
        twoline
        .entityId=${entity.entity_id}
        graphic="avatar"
        .activated=${index === this._activatedIndex}
        .index=${index}
        @keydown=${this._handleListItemKeyDown}
      >
        <ha-icon .icon=${domainIcon(domain)} slot="graphic"></ha-icon>
        ${entity.attributes?.friendly_name
          ? html`
              <span>
                ${entity.attributes?.friendly_name}
              </span>
              <span slot="secondary">${entity.entity_id}</span>
            `
          : html`
              <span>
                ${entity.entity_id}
              </span>
            `}
      </mwc-list-item>
    `;
  }

  private _resetActivatedIndex() {
    this._activatedIndex = 0;
  }

  private _handleInputKeyDown(ev: KeyboardEvent) {
    if (ev.code === "Enter") {
      this._firstListItem?.click();
    } else if (ev.code === "ArrowDown") {
      ev.preventDefault();
      this._firstListItem?.focus();
    }
  }

  private _handleSearchChange(ev: CustomEvent): void {
    const value = ev.detail.value;
    const oldCommandMode = this._commandMode;

    if (value.startsWith(">")) {
      this._commandMode = true;
      this._debounceFilter(value.substring(1));
    } else {
      this._commandMode = false;
      this._debounceFilter(value);
    }

    if (oldCommandMode !== this._commandMode) {
      this._filteredItems = undefined;
    }
  }

  private _debounceFilter = debounce(
    (value: string) => {
      this._filter = value;
    },
    100,
    false
  );

  private _handleListItemKeyDown(ev: KeyboardEvent) {
    const isSingleCharacter = ev.key.length === 1;
    const isFirstListItem = (ev.target as any).index === 0;
    if (ev.key === "ArrowUp") {
      if (isFirstListItem) {
        this._filterInputField?.focus();
      } else {
        this._activatedIndex--;
      }
    } else if (ev.key === "ArrowDown") {
      this._activatedIndex++;
    }

    if (ev.key === "Backspace" || isSingleCharacter) {
      this._filterInputField?.focus();
      this._resetActivatedIndex();
    }
  }

  private _generateCommandItems(): CommandItem[] {
    const reloadableDomains = componentsWithService(this.hass, "reload").sort();

    return reloadableDomains.map((domain) => ({
      text:
        this.hass.localize(`ui.dialogs.quick-bar.commands.reload.${domain}`) ||
        this.hass.localize(
          "ui.dialogs.quick-bar.commands.reload.reload",
          "domain",
          domainToName(this.hass.localize, domain)
        ),
      domain,
      service: "reload",
    }));
  }

  private async _setFilteredItems() {
    this._filteredItems = this._commandMode
      ? this._filterCommandItems(this._commandItems || [], this._filter)
      : this._filterEntityItems(this._entities || [], this._filter);
  }

  private _filterCommandItems = memoizeOne(
    (items: CommandItem[], filter: string): CommandItem[] => {
      return items
        .filter(({ text }) =>
          fuzzySequentialMatch(filter.toLowerCase(), [text.toLowerCase()])
        )
        .sort((itemA, itemB) => compare(itemA.text, itemB.text));
    }
  );

  private _filterEntityItems = memoizeOne(
    (items: HassEntity[], filter: string): HassEntity[] => {
      return items
        .filter(({ entity_id, attributes: { friendly_name } }) => {
          const values = [entity_id];
          if (friendly_name) {
            values.push(friendly_name);
          }
          return fuzzySequentialMatch(filter.toLowerCase(), values);
        })
        .sort((entityA, entityB) =>
          compare(entityA.entity_id, entityB.entity_id)
        );
    }
  );

  private async _processCommand(ev: SingleSelectedEvent) {
    const index = ev.detail.index;
    const item = (ev.target as any).items[index].item;

    this._commandTriggered = index;

    this._runCommandAndCloseDialog({
      domain: item.domain,
      service: item.service,
      serviceData: item.serviceData,
    });
  }

  private async _runCommandAndCloseDialog(request?: ServiceCallRequest) {
    if (!request) {
      return;
    }

    this.hass
      .callService(request.domain, request.service, request.serviceData)
      .then(() => this.closeDialog());
  }

  private _entityMoreInfo(ev: SingleSelectedEvent) {
    const index = ev.detail.index;
    const entityId = (ev.target as any).items[index].entityId;

    this._launchMoreInfoDialog(entityId);
  }

  private _launchMoreInfoDialog(entityId) {
    fireEvent(this, "hass-more-info", { entityId });
    this.closeDialog();
  }

  static get styles() {
    return [
      haStyleDialog,
      css`
        .heading {
          padding: 20px 20px 0px;
        }

        ha-dialog {
          --dialog-z-index: 8;
          --dialog-content-padding: 0;
        }

        @media (min-width: 800px) {
          ha-dialog {
            --mdc-dialog-max-width: 800px;
            --mdc-dialog-min-width: 500px;
            --dialog-surface-position: fixed;
            --dialog-surface-top: 40px;
            --mdc-dialog-max-height: calc(100% - 72px);
          }
        }

        ha-svg-icon.prefix {
          margin: 8px;
        }

        .uni-virtualizer-host {
          display: block;
          position: relative;
          contain: strict;
          overflow: auto;
          height: 100%;
        }

        .uni-virtualizer-host > * {
          box-sizing: border-box;
        }

        mwc-list-item {
          width: 100%;
        }
      `,
    ];
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ha-quick-bar": QuickBar;
  }
}
