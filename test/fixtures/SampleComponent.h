#pragma once

#include "CoreMinimal.h"
#include "Components/ActorComponent.h"
#include "SampleComponent.generated.h"

UCLASS(ClassGroup=(Custom), Blueprintable, meta=(BlueprintSpawnableComponent))
class MYPROJECT_API USampleComponent : public UActorComponent
{
    GENERATED_BODY()

public:
    USampleComponent();

    virtual void TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction* ThisTickFunction) override;

    UFUNCTION(BlueprintCallable, Category="Inventory")
    void AddItem(const FString& ItemName, int32 Count);

    UFUNCTION(BlueprintCallable, BlueprintPure, Category="Inventory")
    int32 GetItemCount(const FString& ItemName) const;

    UFUNCTION(BlueprintCallable, Category="Inventory")
    bool RemoveItem(const FString& ItemName, int32 Count);

protected:
    virtual void BeginPlay() override;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Inventory")
    int32 MaxInventorySize;

    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category="Inventory")
    TArray<FString> InventoryItems;

private:
    UPROPERTY()
    TMap<FString, int32> ItemCounts;

    void ValidateInventory();
};
