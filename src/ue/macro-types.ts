export const UE_MACRO_TYPES = [
  'UCLASS', 'USTRUCT', 'UENUM', 'UPROPERTY', 'UFUNCTION',
  'UINTERFACE', 'UMETA', 'GENERATED_BODY', 'GENERATED_UCLASS_BODY',
  'DECLARE_DYNAMIC_MULTICAST_DELEGATE', 'DECLARE_DELEGATE',
  'DECLARE_EVENT', 'DECLARE_MULTICAST_DELEGATE',
  'DECLARE_DYNAMIC_DELEGATE',
] as const;

export type UEMacroType = typeof UE_MACRO_TYPES[number] | 'OTHER';

export interface UEMacro {
  macroType: UEMacroType;
  lineNumber: number;
  rawText: string;
  specifiers: UESpecifier[];
  metaSpecifiers: UESpecifier[];
}

export interface UESpecifier {
  key: string;
  value: string | null;
  isMeta: boolean;
}

// Known specifiers for validation
export const UCLASS_SPECIFIERS = [
  'Blueprintable', 'BlueprintType', 'NotBlueprintable', 'Abstract',
  'MinimalAPI', 'NotPlaceable', 'Placeable', 'Transient', 'NonTransient',
  'Config', 'DefaultConfig', 'EditInlineNew', 'NotEditInlineNew',
  'Within', 'CollapseCategories', 'DontCollapseCategories',
  'HideCategories', 'ShowCategories', 'ComponentWrapperClass',
  'HideDropdown', 'Deprecated', 'ClassGroup',
];

export const UPROPERTY_SPECIFIERS = [
  'EditAnywhere', 'EditDefaultsOnly', 'EditInstanceOnly', 'VisibleAnywhere',
  'VisibleDefaultsOnly', 'VisibleInstanceOnly', 'BlueprintReadWrite',
  'BlueprintReadOnly', 'BlueprintAssignable', 'BlueprintCallable',
  'Category', 'Transient', 'DuplicateTransient', 'SaveGame',
  'Replicated', 'ReplicatedUsing', 'NotReplicated',
  'Interp', 'Config', 'GlobalConfig', 'EditFixedSize',
  'Export', 'NoClear', 'EditConst', 'BlueprintGetter', 'BlueprintSetter',
  'FieldNotify', 'Getter', 'Setter',
];

export const UFUNCTION_SPECIFIERS = [
  'BlueprintCallable', 'BlueprintPure', 'BlueprintImplementableEvent',
  'BlueprintNativeEvent', 'BlueprintAuthorityOnly', 'BlueprintCosmetic',
  'CallInEditor', 'Category', 'Client', 'Server', 'NetMulticast',
  'Reliable', 'Unreliable', 'WithValidation', 'Exec',
  'BlueprintGetter', 'BlueprintSetter', 'CustomThunk',
  'SealedEvent', 'ServiceRequest', 'ServiceResponse',
];

export const META_SPECIFIERS = [
  'DisplayName', 'ToolTip', 'ShortTooltip', 'DocumentationPolicy',
  'AllowPrivateAccess', 'DeprecatedFunction', 'DeprecationMessage',
  'ClampMin', 'ClampMax', 'UIMin', 'UIMax', 'EditCondition',
  'EditConditionHides', 'InlineEditConditionToggle',
  'MakeStructureDefaultValue', 'AllowedClasses', 'DisallowedClasses',
  'ExactClass', 'MustImplement', 'BlueprintBaseOnly', 'BindWidget',
  'BindWidgetOptional', 'BindWidgetAnim', 'BindWidgetAnimOptional',
  'Keywords', 'CompactNodeTitle', 'ArrayParm', 'MapParam',
  'ReturnDisplayName', 'AdvancedDisplay', 'DevelopmentOnly',
  'NativeBreakFunc', 'NativeMakeFunc', 'HidePin', 'DefaultToSelf',
  'WorldContext', 'CallableWithoutWorldContext', 'Latent',
  'LatentInfo', 'ExpandEnumAsExecs', 'ExpandBoolAsExecs',
  'CommutativeAssociativeBinaryOperator',
];

export function isBlueprintExposed(specifiers: UESpecifier[]): boolean {
  const bpKeys = new Set([
    'BlueprintCallable', 'BlueprintPure', 'BlueprintReadWrite',
    'BlueprintReadOnly', 'BlueprintImplementableEvent',
    'BlueprintNativeEvent', 'BlueprintAssignable', 'BlueprintCallable',
    'Blueprintable', 'BlueprintType', 'BlueprintGetter', 'BlueprintSetter',
  ]);
  return specifiers.some(s => bpKeys.has(s.key));
}
