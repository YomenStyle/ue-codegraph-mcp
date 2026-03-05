#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "SampleActor.generated.h"

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnHealthChanged, float, NewHealth);

UCLASS(Blueprintable, BlueprintType, meta=(DisplayName="Sample Actor"))
class MYPROJECT_API ASampleActor : public AActor
{
    GENERATED_BODY()

public:
    ASampleActor();

    virtual void BeginPlay() override;
    virtual void Tick(float DeltaTime) override;

    UFUNCTION(BlueprintCallable, Category="Health")
    void TakeDamage(float DamageAmount);

    UFUNCTION(BlueprintCallable, BlueprintPure, Category="Health")
    float GetHealth() const;

    UFUNCTION(BlueprintImplementableEvent, Category="Health")
    void OnDeath();

    UFUNCTION(BlueprintNativeEvent, Category="Combat")
    void ApplyEffect(const FString& EffectName, float Duration);

protected:
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Health",
        meta=(ClampMin="0.0", ClampMax="1000.0"))
    float MaxHealth;

    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category="Health")
    float CurrentHealth;

    UPROPERTY(BlueprintAssignable, Category="Health")
    FOnHealthChanged OnHealthChanged;

    UPROPERTY(EditDefaultsOnly, Category="Combat")
    TSubclassOf<class UDamageType> DefaultDamageType;

private:
    void UpdateHealthUI();
    void NotifyHealthChanged();

    UPROPERTY()
    bool bIsDead;
};
